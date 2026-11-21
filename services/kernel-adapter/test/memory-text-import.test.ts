import { describe, expect, it, vi } from 'vitest';
import { METHOD, NOTIFICATION, type JsonRpcPeer } from '@evowork/protocol';
import { memoryNoteReceipt } from '@evowork/policy';
import { createMemoryTextImporter, type MemoryTextRecord } from '../src/memory-text-import.js';

function fixture(initialRecords: readonly MemoryTextRecord[] = []) {
  let stored: readonly MemoryTextRecord[] = initialRecords;
  const calls: { method: string; params: unknown }[] = [];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  let behavior:
    | 'saved'
    | 'claim'
    | 'wrong-source'
    | 'wrong-order'
    | 'changed'
    | 'hold'
    | 'failed'
    | 'failed-after-save'
    | 'receipt-hold'
    | 'start-error'
    | 'interrupted' = 'saved';
  const emit = (name: string, params: unknown) => {
    for (const h of handlers.get(name) ?? []) h(params);
  };
  const peer = {
    onNotification(name: string, h: (params: unknown) => void) {
      const set = handlers.get(name) ?? new Set();
      set.add(h);
      handlers.set(name, set);
      return () => set.delete(h);
    },
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === METHOD.threadStart) {
        if (behavior === 'start-error') throw new Error('sensitive provider details');
        return { thread: { id: 'native-thread' } };
      }
      if (method === METHOD.turnStart) {
        const p = params as { input: readonly { text: string }[] };
        const args = JSON.parse(p.input[0]!.text.split('\n').at(-1)!) as {
          filename: string;
          note: string;
        };
        expect(stored[0]?.state).toBe('pending');
        if (!['claim', 'hold', 'failed', 'interrupted'].includes(behavior))
          emit(NOTIFICATION.hookCompleted, {
            threadId: 'native-thread',
            run: {
              eventName: 'postToolUse',
              handlerType: 'command',
              executionMode: 'sync',
              status: 'completed',
              sourcePath: behavior === 'wrong-source' ? '/other/hooks.json' : '/trusted/hooks.json',
              displayOrder: behavior === 'wrong-order' ? 99 : 2,
              entries: [
                {
                  kind: 'context',
                  text: memoryNoteReceipt('memoriesadd_ad_hoc_note', {
                    ...args,
                    note: behavior === 'changed' ? 'altered content' : args.note,
                  }),
                },
              ],
            },
          });
        if (!['hold', 'receipt-hold'].includes(behavior))
          emit(NOTIFICATION.turnCompleted, {
            threadId: 'native-thread',
            turn: {
              status: behavior.startsWith('failed')
                ? 'failed'
                : behavior === 'interrupted'
                  ? 'interrupted'
                  : 'completed',
            },
          });
        return { turn: { id: 'turn' } };
      }
      return {};
    },
  };
  const build = (available = true) =>
    createMemoryTextImporter({
      peer: () => peer as unknown as JsonRpcPeer,
      ready: () => true,
      hookSources: ['/trusted/hooks.json'],
      hooksAvailable: async () =>
        available ? [{ sourcePath: '/trusted/hooks.json', displayOrder: 2 }] : [],
      read: () => stored,
      write: (r) => {
        stored = r;
      },
      timeoutMs: 50,
    });
  const importer = build();
  return {
    importer,
    build,
    calls,
    emit,
    behavior: (v: typeof behavior) => {
      behavior = v;
    },
    stored: () => stored,
  };
}
const input = { text: 'Synthetic preference', model: 'available' };
const personal = { cwd: '/work', scope: 'personal' };

describe('WorkBuddy native memory tool import', () => {
  it('only a matching trusted successful hook receipt proves saving; globals and raw events untouched', async () => {
    const f = fixture();
    expect((await f.importer.import(input, personal)).record.state).toBe('saved');
    const start = f.calls.find((c) => c.method === METHOD.threadStart)?.params as Record<
      string,
      unknown
    >;
    expect(start.ephemeral).toBe(true);
    expect(start.experimentalRawEvents).toBeUndefined();
    expect(f.calls.some((c) => c.method === METHOD.configBatchWrite)).toBe(false);
    expect(JSON.stringify(f.stored())).not.toContain(input.text);
  });
  it.each(['claim', 'wrong-source', 'wrong-order', 'changed'] as const)(
    'does not trust %s or replay an unconfirmed operation',
    async (behavior) => {
      const f = fixture();
      f.behavior(behavior);
      expect((await f.importer.import(input, personal)).record).toMatchObject({
        state: 'failed',
        reason: behavior === 'changed' ? 'receipt_mismatch' : 'receipt_missing',
      });
      expect((await f.build().import(input, personal)).duplicate).toBe(true);
      expect(f.calls.filter((c) => c.method === METHOD.turnStart)).toHaveLength(1);
    },
  );
  it('a confirmed native save remains saved even if the final model response fails', async () => {
    const f = fixture();
    f.behavior('failed-after-save');
    expect((await f.importer.import(input, personal)).record.state).toBe('saved');
  });
  it('persists a trusted save before the final model reply, including across app restart', async () => {
    const f = fixture();
    f.behavior('receipt-hold');
    let finished = false;
    const pending = f.importer.import(input, personal).then((result) => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(f.stored()[0]?.state).toBe('saved'), { interval: 1 });
    expect(finished).toBe(false);
    expect(f.build().history()[0]?.state).toBe('saved');
    f.importer.invalidate();
    expect((await pending).record.state).toBe('saved');
    expect((await f.build().import(input, personal)).duplicate).toBe(true);
  });
  it('keeps a confirmed save on timeout while quarantining a turn that may still be running', async () => {
    const f = fixture();
    f.behavior('receipt-hold');
    expect((await f.importer.import(input, personal)).record.state).toBe('saved');
    expect(f.importer.isBusy()).toBe(true);
    expect(f.calls.find((c) => c.method === METHOD.turnInterrupt)?.params).toEqual({
      threadId: 'native-thread',
      turnId: 'turn',
    });
  });
  it('records request failure before creating a turn without persisting provider text', async () => {
    const f = fixture();
    f.behavior('start-error');
    expect((await f.importer.import(input, personal)).record).toMatchObject({
      state: 'failed',
      reason: 'request_failed',
    });
    expect(JSON.stringify(f.stored())).not.toContain('sensitive');
    expect(f.calls.some((c) => c.method === METHOD.turnStart)).toBe(false);
  });
  it('persists an interrupted app session with a reason while keeping legacy unknown operations deduplicated', async () => {
    const f = fixture();
    const saved = (await f.importer.import(input, personal)).record;
    const restarted = fixture([{ ...saved, state: 'pending' }]);
    expect(restarted.stored()[0]).toMatchObject({ state: 'unknown', reason: 'app_restarted' });
    expect((await restarted.importer.import(input, personal)).duplicate).toBe(true);
    const legacy = fixture([{ ...saved, state: 'unknown' }]);
    expect((await legacy.importer.import(input, personal)).duplicate).toBe(true);
    expect(legacy.calls).toHaveLength(0);
  });
  it.each(['failed', 'interrupted'] as const)(
    'persists a diagnostic terminal result for a %s turn without replay',
    async (behavior) => {
      const f = fixture();
      f.behavior(behavior);
      const result = await f.importer.import(input, personal);
      expect(result.record).toMatchObject({ state: 'failed', reason: `turn_${behavior}` });
      expect(f.build().history()[0]).toEqual(result.record);
      expect((await f.build().import(input, personal)).duplicate).toBe(true);
      expect(f.calls.filter((c) => c.method === METHOD.turnStart)).toHaveLength(1);
    },
  );
  it('normalizes BOM and newlines for deduplication but preserves distinct scopes', async () => {
    const f = fixture();
    await f.importer.import({ ...input, text: '\uFEFF A\r\nB \n' }, personal);
    expect((await f.importer.import({ ...input, text: 'A\nB' }, personal)).duplicate).toBe(true);
    expect(
      (await f.importer.import({ ...input, text: 'A\nB' }, { ...personal, scope: 'project:beta' }))
        .duplicate,
    ).toBeUndefined();
  });
  it('keeps multiline Unicode and literal escapes readable without a nested JSON string', async () => {
    const f = fixture();
    const text = '# 偏好\n保留路径 C:\\reports、字面量 \\n 与引号「"原文"」。';
    expect((await f.importer.import({ ...input, text }, personal)).record.state).toBe('saved');
    const turn = f.calls.find((c) => c.method === METHOD.turnStart)?.params as {
      input: readonly { text: string }[];
    };
    const args = JSON.parse(turn.input[0]!.text.split('\n').at(-1)!) as { note: string };
    expect(args.note).toContain(`---\n${text}\n--- END WORKBUDDY SNAPSHOT`);
  });
  it('refuses invalid and oversized content before creating a native session', async () => {
    const f = fixture();
    for (const text of ['', '\u0000binary', '汉'.repeat(22000)])
      await expect(f.importer.import({ ...input, text }, personal)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it('refuses before submission when the trusted synchronous completion hook is unavailable', async () => {
    const f = fixture();
    const unsupported = f.build(false);
    expect(await unsupported.supported()).toBe(false);
    await expect(unsupported.import(input, personal)).rejects.toThrow('回执不可用');
    expect(f.calls).toHaveLength(0);
    expect(f.stored()).toHaveLength(0);
  });
  it('disconnect settles unknown without automatic retry and excludes a concurrent write', async () => {
    const f = fixture();
    f.behavior('hold');
    const first = f.importer.import(input, personal);
    await vi.waitFor(() => expect(f.calls.some((c) => c.method === METHOD.turnStart)).toBe(true));
    await expect(f.importer.import(input, personal)).rejects.toThrow('正在导入');
    f.importer.invalidate();
    expect((await first).record).toMatchObject({ state: 'unknown', reason: 'disconnected' });
    expect((await f.importer.import(input, personal)).duplicate).toBe(true);
  });
  it('times out with the actual native turn id and prevents other memory writes until a restart', async () => {
    const f = fixture();
    f.behavior('hold');
    const result = await f.importer.import(input, personal);
    expect(result.record).toMatchObject({ state: 'unknown', reason: 'timeout' });
    expect(f.calls.find((c) => c.method === METHOD.turnInterrupt)?.params).toEqual({
      threadId: 'native-thread',
      turnId: 'turn',
    });
    expect(f.importer.isBusy()).toBe(true);
    f.importer.invalidate();
    expect(f.importer.isBusy()).toBe(false);
    expect((await f.importer.import(input, personal)).duplicate).toBe(true);
  });
});
