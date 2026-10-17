// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openStore, type Store } from '@evowork/store';
import type { Adapter } from '@evowork/kernel-adapter';
import { makeThread } from '../../../services/kernel-adapter/test/fake-app-server.js';
import { createFileHost } from '../src/main/file-host.js';

let directory: string, root: string, store: Store;
let host: ReturnType<typeof createFileHost>;
let live = true;
const emit = vi.fn(),
  register = vi.fn();
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'evowork-file-host-'));
  root = join(directory, 'workspace');
  mkdirSync(root);
  store = openStore({ path: ':memory:' });
  for (const id of ['a', 'b']) store.threads.upsertFromThread(makeThread({ id, cwd: root }));
  live = true;
  emit.mockClear();
  register.mockClear();
  host = createFileHost({
    directory: join(directory, 'undo'),
    store,
    adapter: () =>
      ({
        resolveWorkspaceFileToolCall: (id: string) =>
          live && id === 'a' ? { callId: 'call', turnId: 'turn', generation: 1 } : undefined,
      }) as unknown as Adapter,
    configPath: join(directory, 'config.toml'),
    emit,
    register,
  });
  await host.ready;
  host.onEvent({ type: 'turn-started', threadId: 'a', turnId: 'turn' });
});
afterEach(() => {
  host.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
async function call(
  name: string,
  args: object = {},
  id = 'a',
  token = host.environment.EVOWORK_FILES_TOKEN,
) {
  return fetch(host.environment.EVOWORK_FILES_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args, threadId: id, sessionId: 'native-session' }),
  });
}

it('shell 文件先发现但不认领；明确打开只发事件，显式登记才建立归属', async () => {
  writeFileSync(join(root, 'output.txt'), 'generated');
  host.journal.capture('a');
  const listed = await (await call('list_files')).json();
  expect(listed.files).toMatchObject([
    { path: expect.stringContaining('output.txt'), source: 'workspace' },
  ]);
  expect((await call('open_file', { path: 'output.txt' })).status).toBe(200);
  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'file-open-requested',
      taskId: 'a',
      path: expect.stringContaining('output.txt'),
    }),
  );
  expect(register).not.toHaveBeenCalled();
  expect((await call('register_file', { path: 'output.txt' })).status).toBe(200);
  expect(register).toHaveBeenCalledWith('a', expect.stringContaining('output.txt'));
  expect(host.view('a')?.files[0]?.source).toBe('task');
});

it('错误凭据、别的任务、过期调用、自报身份与越界路径不能打开文件', async () => {
  writeFileSync(join(root, 'output.txt'), 'generated');
  expect((await call('open_file', { path: 'output.txt' }, 'a', 'wrong')).status).toBe(403);
  expect((await call('open_file', { path: 'output.txt' }, 'b')).status).toBe(400);
  expect((await call('open_file', { path: 'output.txt', threadId: 'b' })).status).toBe(400);
  live = false;
  expect((await call('open_file', { path: 'output.txt' })).status).toBe(400);
  live = true;
  writeFileSync(join(directory, 'outside.txt'), 'secret');
  symlinkSync(join(directory, 'outside.txt'), join(root, 'link.txt'));
  expect((await call('open_file', { path: '../outside.txt' })).status).toBe(400);
  expect((await call('open_file', { path: 'link.txt' })).status).toBe(400);
  const old = host.environment.EVOWORK_FILES_TOKEN;
  host.rotate();
  expect((await call('open_file', { path: 'output.txt' }, 'a', old)).status).toBe(403);
  expect(emit.mock.calls.some(([e]) => e.type === 'file-open-requested')).toBe(false);
});

it('文件发现分页覆盖所有条目，工具结果不混入完整 diff 或文件内容', async () => {
  for (let i = 0; i < 105; i++)
    writeFileSync(join(root, `file-${String(i).padStart(3, '0')}.txt`), 'private document body');
  host.journal.capture('a');
  const first = await (await call('list_files')).json();
  const second = await (await call('list_files', { cursor: first.nextCursor })).json();
  expect(first.files).toHaveLength(100);
  expect(second.files).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.files, ...second.files].map((f) => f.path)).size).toBe(105);
  expect(JSON.stringify(first)).not.toContain('private document body');
  expect((await call('list_files', { cursor: 'not-a-cursor' })).status).toBe(400);
});

it('重叠工作目录有另一任务运行时，撤销按钮不可用且磁盘操作被拒绝', () => {
  writeFileSync(join(root, 'new.txt'), 'generated');
  host.onEvent({ type: 'turn-completed', threadId: 'a', turnId: 'turn', status: 'completed' });
  const file = host.view('a')!.thread[0]!;
  expect(file.reversible).toBe(true);
  store.db
    .prepare("UPDATE thread_projection SET last_turn_status='inProgress' WHERE thread_id='b'")
    .run();
  expect(host.view('a')!.thread[0]!.reversible).toBe(false);
  expect(() =>
    host.journal.revert({
      threadId: 'a',
      path: file.path,
      revision: file.revision,
      scope: 'thread',
    }),
  ).toThrow('任务运行');
});
