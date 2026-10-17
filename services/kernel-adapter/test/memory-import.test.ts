import { ERROR_CODE, JsonRpcCallError, METHOD, type JsonRpcPeer } from '@evowork/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryImporter } from '../src/memory-import.js';

function fixture() {
  const calls: { method: string; params: unknown }[] = [];
  let enabled = true;
  let projects = ['alpha', 'beta'];
  let importError = false;
  let holdImport = false;
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
        if (holdImport) return await new Promise<T>(() => {});
        if (importError) throw new Error('connection lost after write');
        return { importId: 'native-import' } as T;
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  return {
    importer: createMemoryImporter(() => peer as JsonRpcPeer),
    calls,
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
