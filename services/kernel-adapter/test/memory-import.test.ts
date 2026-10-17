import { ERROR_CODE, JsonRpcCallError, METHOD, type JsonRpcPeer } from '@evowork/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type MemoryImportSync, createMemoryImporter } from '../src/memory-import.js';

function fixture(persistence?: {
  read(): MemoryImportSync | undefined;
  write(value: MemoryImportSync): void;
}) {
  const calls: { method: string; params: unknown }[] = [];
  let enabled = true;
  let projects = ['alpha', 'beta'];
  let importError = false;
  let holdImport = false;
  let releaseImport: (() => void) | undefined;
  let histories: unknown[] = [];
  let unsupported = false;
  const peer = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (unsupported) throw new JsonRpcCallError(method, ERROR_CODE.methodNotFound, 'missing');
      if (method === METHOD.configRead)
        return { config: { features: { external_agent_memory_import: enabled } } } as T;
      if (method === METHOD.externalAgentImportHistoriesRead) return { data: histories } as T;
      if (method === METHOD.externalAgentDetect)
        return {
          items: [
            { itemType: 'CONFIG', description: 'settings', cwd: null },
            {
              itemType: 'SESSIONS',
              details: {
                sessions: [{ path: '/source/projects/alpha/chat.jsonl', cwd: '/work/alpha' }],
              },
            },
            { itemType: 'MEMORY', details: { memory: projects } },
          ],
        } as T;
      if (method === METHOD.externalAgentImport) {
        if (holdImport)
          return await new Promise<T>((resolve) => {
            releaseImport = () => resolve({ importId: 'native-import' } as T);
          });
        if (importError) throw new Error('connection lost after write');
        return { importId: 'native-import' } as T;
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  return {
    importer: createMemoryImporter(() => peer as JsonRpcPeer, persistence),
    calls,
    releaseImport() {
      releaseImport?.();
    },
    configure(input: {
      enabled?: boolean;
      projects?: string[];
      importError?: boolean;
      holdImport?: boolean;
      histories?: unknown[];
      unsupported?: boolean;
    }) {
      enabled = input.enabled ?? enabled;
      projects = input.projects ?? projects;
      importError = input.importError ?? importError;
      holdImport = input.holdImport ?? holdImport;
      histories = input.histories ?? histories;
      unsupported = input.unsupported ?? unsupported;
    },
  };
}

describe('项目记忆导入边界', () => {
  it('读取历史不扫描来源；只导入本次选中的项目，不迁移配置或会话', async () => {
    const f = fixture();
    expect((await f.importer.status()).supported).toBe(true);
    expect(f.calls.some((call) => call.method === METHOD.externalAgentDetect)).toBe(false);
    const detected = await f.importer.detect();
    expect(detected.projects).toEqual([{ key: 'alpha', path: '/work/alpha' }, { key: 'beta' }]);
    await expect(
      f.importer.import({ selectionId: detected.selectionId, projectKeys: ['beta'] }),
    ).resolves.toEqual({ importId: 'native-import' });
    expect(f.calls.find((call) => call.method === METHOD.externalAgentImport)?.params).toEqual({
      migrationItems: [
        {
          itemType: 'MEMORY',
          description: '导入项目记忆',
          cwd: null,
          details: { memory: ['beta'] },
        },
      ],
      source: 'evowork',
      providerId: 'claude-code',
    });
    expect(f.calls.some((call) => call.method === METHOD.configBatchWrite)).toBe(false);
  });

  it('拒绝伪造、空选择和过期选择，不发起迁移', async () => {
    const f = fixture();
    const old = await f.importer.detect();
    const current = await f.importer.detect();
    for (const input of [
      { selectionId: old.selectionId, projectKeys: ['alpha'] },
      { selectionId: current.selectionId, projectKeys: ['foreign'] },
      { selectionId: current.selectionId, projectKeys: [] },
    ])
      await expect(f.importer.import(input)).rejects.toThrow('项目选择已失效');
    expect(f.calls.some((call) => call.method === METHOD.externalAgentImport)).toBe(false);
  });

  it('提交前重新核对来源，失踪或已导入项目不重放', async () => {
    const f = fixture();
    const detected = await f.importer.detect();
    f.configure({ projects: [] });
    await expect(
      f.importer.import({ selectionId: detected.selectionId, projectKeys: ['alpha'] }),
    ).rejects.toThrow('来源项目已变化');
    expect(f.calls.some((call) => call.method === METHOD.externalAgentImport)).toBe(false);
  });

  it('写请求失败后不能重放旧选择，重启也使选择失效', async () => {
    const f = fixture();
    const detected = await f.importer.detect();
    f.configure({ importError: true });
    const input = { selectionId: detected.selectionId, projectKeys: ['alpha'] };
    await expect(f.importer.import(input)).rejects.toThrow();
    await expect(f.importer.import(input)).rejects.toThrow('选择已失效');
    expect(f.calls.filter((call) => call.method === METHOD.externalAgentImport)).toHaveLength(1);
    const next = await f.importer.detect();
    f.importer.invalidate();
    await expect(f.importer.import({ ...input, selectionId: next.selectionId })).rejects.toThrow(
      '选择已失效',
    );
  });

  it('写请求无响应时有界返回，旧选择不能自动重放', async () => {
    const f = fixture();
    const detected = await f.importer.detect();
    f.configure({ holdImport: true });
    vi.useFakeTimers();
    try {
      const input = { selectionId: detected.selectionId, projectKeys: ['alpha'] };
      const mutation = f.importer.import(input);
      const assertion = expect(mutation).rejects.toThrow('导入操作暂未返回');
      await vi.advanceTimersByTimeAsync(20_001);
      await assertion;
      await expect(f.importer.import(input)).rejects.toThrow('选择已失效');
      expect(f.calls.filter((call) => call.method === METHOD.externalAgentImport)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('关闭和不支持时给出明确原因，不扫描来源', async () => {
    const f = fixture();
    f.configure({ enabled: false });
    expect(await f.importer.status()).toMatchObject({
      supported: false,
      reason: expect.stringContaining('未开启'),
    });
    await expect(f.importer.detect()).rejects.toThrow('未开启');
    f.configure({ unsupported: true });
    expect(await f.importer.status()).toMatchObject({
      supported: false,
      reason: expect.stringContaining('不支持'),
    });
    expect(f.calls.some((call) => call.method === METHOD.externalAgentDetect)).toBe(false);
  });

  it('原生历史保留部分成功并翻译失败原因，过滤其他类型和内部路径', async () => {
    const f = fixture();
    f.configure({
      histories: [
        {
          importId: 'partial',
          completedAtMs: 123,
          successes: [
            { itemType: 'CONFIG', source: '/internal/config' },
            { itemType: 'MEMORY', source: 'alpha', target: '/internal/memory' },
          ],
          failures: [
            {
              itemType: 'MEMORY',
              source: 'beta',
              message: 'permission denied /internal/path',
              failureStage: 'import',
            },
          ],
        },
      ],
    });
    expect(await f.importer.history()).toEqual([
      {
        id: 'partial',
        completedAt: 123,
        projects: [
          { key: 'alpha', ok: true },
          { key: 'beta', ok: false, reason: '无法读取来源文件，请检查目录权限。' },
        ],
      },
    ]);
  });
});

describe('原生增量同步调度', () => {
  const imported = (id = 'previous', key = 'alpha') => ({
    importId: id,
    providerId: 'claude-code',
    completedAtMs: Date.now(),
    successes: [{ itemType: 'MEMORY', source: key }],
    failures: [],
  });
  it('默认关闭及关闭后零来源检测；开启仅同步确认时的已导入项目，不扩大到新项目', async () => {
    vi.useFakeTimers();
    let saved: MemoryImportSync | undefined;
    const f = fixture({
      read: () => saved,
      write: (value) => {
        saved = value;
      },
    });
    try {
      f.importer.start();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(f.calls.some((call) => call.method === METHOD.externalAgentDetect)).toBe(false);
      f.configure({ histories: [imported()] });
      await f.importer.setSync(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(saved?.enabled).toBe(true);
      expect(saved?.pending?.id).toBe('native-import');
      expect(
        f.calls.find((call) => call.method === METHOD.externalAgentImport)?.params,
      ).toMatchObject({
        migrationItems: [{ itemType: 'MEMORY', details: { memory: ['alpha'] } }],
      });
      f.configure({ histories: [imported(), imported('native-import'), imported('new', 'beta')] });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(saved?.lastCompletedAt).toBeDefined();
      expect(saved?.projectKeys).toEqual(['alpha']);
      await f.importer.setSync(false);
      const count = f.calls.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(f.calls).toHaveLength(count);
      const restarted = fixture({
        read: () => saved,
        write: (value) => {
          saved = value;
        },
      });
      restarted.importer.start();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(restarted.calls).toHaveLength(0);
      restarted.importer.stop();
    } finally {
      f.importer.stop();
      vi.useRealTimers();
    }
  });
  it('写入前持久化暂停状态，丢失回复后不自动重放，重开仍暂停', async () => {
    vi.useFakeTimers();
    let saved: MemoryImportSync | undefined;
    const snapshots: MemoryImportSync[] = [];
    const f = fixture({
      read: () => saved,
      write: (value) => {
        saved = value;
        snapshots.push(value);
      },
    });
    try {
      f.configure({ histories: [imported()], holdImport: true });
      await f.importer.setSync(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(saved).toMatchObject({ enabled: false, projectKeys: ['alpha'] });
      await vi.advanceTimersByTimeAsync(200_000);
      expect(f.calls.filter((c) => c.method === METHOD.externalAgentImport)).toHaveLength(1);
      expect(saved?.error).toContain('暂停');
      f.importer.stop();
      const restarted = fixture({
        read: () => saved,
        write: (value) => {
          saved = value;
        },
      });
      restarted.importer.start();
      await vi.advanceTimersByTimeAsync(120_001);
      expect(restarted.calls).toHaveLength(0);
      restarted.importer.stop();
      expect(snapshots.some((value) => value.enabled)).toBe(true);
    } finally {
      f.importer.stop();
      vi.useRealTimers();
    }
  });
  it('同步批次部分失败后暂停，不把导入完成当作整理就绪', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.configure({ histories: [imported()] });
      await f.importer.setSync(true);
      await vi.advanceTimersByTimeAsync(1);
      f.configure({
        histories: [
          {
            ...imported('native-import'),
            successes: [],
            failures: [{ itemType: 'MEMORY', source: 'alpha', message: 'permission denied' }],
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(60_001);
      expect((await f.importer.status()).sync).toMatchObject({
        enabled: false,
        error: expect.stringContaining('部分项目同步失败'),
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.calls.filter((c) => c.method === METHOD.externalAgentImport)).toHaveLength(1);
    } finally {
      f.importer.stop();
      vi.useRealTimers();
    }
  });
  it('关闭或内核丢失时，迟到响应不能重新开启同步；不消费手动向导选择', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const selection = await f.importer.detect();
      f.configure({ histories: [imported()], projects: [] });
      await f.importer.setSync(true);
      await vi.advanceTimersByTimeAsync(1);
      f.configure({ projects: ['alpha'] });
      await f.importer.setSync(false);
      await f.importer.import({ selectionId: selection.selectionId, projectKeys: ['alpha'] });
      expect((await f.importer.status()).sync?.enabled).toBe(false);
      f.configure({ holdImport: true });
      await f.importer.setSync(true);
      await vi.advanceTimersByTimeAsync(1);
      f.importer.invalidate();
      await vi.advanceTimersByTimeAsync(200_001);
      expect((await f.importer.status()).sync?.enabled).toBe(false);
    } finally {
      f.importer.stop();
      vi.useRealTimers();
    }
  });
  it('没有 Claude Code 成功导入记录时不能开启，不扫描来源', async () => {
    const f = fixture();
    f.configure({ histories: [{ ...imported(), providerId: 'cursor' }] });
    await expect(f.importer.setSync(true)).rejects.toThrow('请先导入');
    expect(f.calls.some((c) => c.method === METHOD.externalAgentDetect)).toBe(false);
    await expect(f.importer.setSync('true' as unknown as boolean)).rejects.toThrow('同步设置无效');
  });
});

describe('同步关闭、重开与清空竞态', () => {
  const records = [
    {
      importId: 'previous',
      providerId: 'claude-code',
      completedAtMs: 1,
      successes: [{ itemType: 'MEMORY', source: 'alpha' }],
      failures: [],
    },
  ];
  it('关闭后迟到的真实写响应不能重新启用，清空也不能穿过在途同步', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.configure({ histories: records, holdImport: true });
      await f.importer.setSync(true);
      await vi.advanceTimersByTimeAsync(1);
      const reset = vi.fn(async () => true);
      await expect(f.importer.reset(reset)).rejects.toThrow('正在导入或同步');
      expect(reset).not.toHaveBeenCalled();
      await f.importer.setSync(false);
      f.releaseImport();
      await vi.advanceTimersByTimeAsync(1);
      expect((await f.importer.status()).sync?.enabled).toBe(false);
      await f.importer.reset(reset);
      expect(reset).toHaveBeenCalledOnce();
      expect((await f.importer.status()).sync).toMatchObject({ enabled: false, projectKeys: [] });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.calls.filter((c) => c.method === METHOD.externalAgentImport)).toHaveLength(1);
    } finally {
      f.importer.stop();
      vi.useRealTimers();
    }
  });
  it('只读检测后正常退出保留开启和范围，新实例自动检测并同步原授权项目', async () => {
    vi.useFakeTimers();
    let saved: MemoryImportSync | undefined;
    const persistence = {
      read: () => saved,
      write: (value: MemoryImportSync) => {
        saved = value;
      },
    };
    const f = fixture(persistence);
    const restarted = () => fixture(persistence);
    try {
      f.configure({ histories: records, projects: [] });
      await f.importer.setSync(true);
      await vi.advanceTimersByTimeAsync(1);
      f.importer.stop();
      expect(saved).toMatchObject({ enabled: true, projectKeys: ['alpha'] });
      const next = restarted();
      next.configure({ histories: records });
      next.importer.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(next.calls.find((c) => c.method === METHOD.externalAgentImport)?.params).toMatchObject(
        { migrationItems: [{ details: { memory: ['alpha'] } }] },
      );
      next.importer.stop();
    } finally {
      f.importer.stop();
      vi.useRealTimers();
    }
  });
});

it('前台核对批次不能把下一次来源检测提前到一秒后', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const record = (id: string) => ({
    importId: id,
    providerId: 'claude-code',
    completedAtMs: 1,
    successes: [{ itemType: 'MEMORY', source: 'alpha' }],
    failures: [],
  });
  try {
    f.configure({ histories: [record('first')] });
    await f.importer.setSync(true);
    await vi.advanceTimersByTimeAsync(1);
    f.configure({ histories: [record('first'), record('native-import')] });
    expect((await f.importer.status()).sync?.pending).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.calls.filter((call) => call.method === METHOD.externalAgentDetect)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(f.calls.filter((call) => call.method === METHOD.externalAgentDetect)).toHaveLength(2);
  } finally {
    f.importer.stop();
    vi.useRealTimers();
  }
});
