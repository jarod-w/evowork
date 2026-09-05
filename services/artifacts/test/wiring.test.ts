/**
 * fs/watch ↔ 产物索引 · 分享上传 的接线。
 *
 * 两块的共同点：**它们都在"事情已经发生了"之后才被调用**，所以错的表现不是报错，
 * 而是"产物没出现在结果区"或"云端留了个半截文件"。
 */
import { createLogger } from '@evowork/logging';
import { describe, expect, it, vi } from 'vitest';

import {
  createArtifactWatcher,
  createPollingFileSystem,
  createUploader,
  digestName,
  hashSharePassword,
  MAX_SHARE_BYTES,
  type ArtifactRecord,
  type FileSystemPort,
  type IndexPort,
} from '../src/index.js';

const NOW = Date.parse('2026-09-05T10:00:00Z');

/**
 * 记录日志的假 Logger。
 *
 * 用 `createLogger` 的内存 sink 而不是自己拼一个对象：这样断言"日志里没有文件名"
 * 检查的是**真的经过字段策略之后**的结果，而不是我们自己拼的字符串。
 */
function recordingLogger(logs: Record<string, unknown>[]) {
  return createLogger({
    service: 'test',
    onViolation: 'drop',
    sink: (entry) => logs.push(entry as unknown as Record<string, unknown>),
  });
}

/** 内存版索引 + 文件系统。 */
function harness(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const records: ArtifactRecord[] = [];
  let counter = 0;

  const fs: FileSystemPort = {
    listFiles: () => [...disk.keys()],
    stat: (path) => {
      const content = disk.get(path);
      return content === undefined
        ? undefined
        : { sizeBytes: content.length, contentHash: `h:${content}` };
    },
    watch: () => () => undefined,
  };

  const index: IndexPort = {
    latestFor: (path) =>
      [...records].reverse().find((r) => r.path === path && r.fileState !== 'MISSING'),
    insert: (record) => records.push(record),
    update: (record) => {
      const at = records.findIndex((r) => r.id === record.id);
      if (at >= 0) records[at] = record;
    },
    listPresent: () => records.filter((r) => r.fileState === 'PRESENT'),
    setFileState: (id, state, path) => {
      const at = records.findIndex((r) => r.id === id);
      if (at >= 0) {
        const record = records[at] as ArtifactRecord;
        records[at] = { ...record, fileState: state, ...(path ? { path } : {}) };
      }
    },
  };

  const watcher = createArtifactWatcher({
    fs,
    index,
    now: () => NOW,
    newId: () => `af_${(counter += 1)}`,
    threadId: 't1',
  });
  return { watcher, records, disk, fs, index };
}

describe('对账补上丢掉的事件（`fs.watch` 一定会丢）', () => {
  it('磁盘上有、索引里没有 → 补进索引', () => {
    const { watcher, records } = harness({ '/w/report.docx': 'v1', '/w/data.csv': 'a,b' });
    const stats = watcher.reconcile('/w');
    expect(stats.added).toBe(2);
    expect(records.map((r) => r.artifactType).sort()).toEqual(['document', 'spreadsheet']);
  });

  it('中间产物不进索引', () => {
    const { watcher, records } = harness({
      '/w/report.docx': 'v1',
      '/w/node_modules/x/a.js': 'x',
      '/w/uploads/20260905-x/content.md': 'y',
    });
    watcher.reconcile('/w');
    expect(records).toHaveLength(1);
  });

  it('再对账一次不会重复插入（内容没变）', () => {
    const { watcher, records } = harness({ '/w/report.docx': 'v1' });
    watcher.reconcile('/w');
    watcher.reconcile('/w');
    expect(records).toHaveLength(1);
  });
});

describe('**移动优先按内容哈希重新定位**（08 §8）', () => {
  it('用户在 Finder 里挪了文件 → 标 MOVED 到新路径，而不是"文件已不存在"', () => {
    const { watcher, records, disk } = harness({ '/w/report.docx': 'v1' });
    watcher.reconcile('/w');

    disk.delete('/w/report.docx');
    disk.set('/w/archive/report.docx', 'v1'); // 同一份内容
    const stats = watcher.reconcile('/w');

    expect(stats.moved).toBe(1);
    expect(stats.missing).toBe(0);
    expect(records.find((r) => r.id === 'af_1')?.path).toBe('/w/archive/report.docx');
  });

  it('真的删掉了 → MISSING，但**索引条目保留**（"重新生成"要靠它）', () => {
    const { watcher, records, disk } = harness({ '/w/report.docx': 'v1' });
    watcher.reconcile('/w');
    disk.delete('/w/report.docx');
    const stats = watcher.reconcile('/w');

    expect(stats.missing).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.fileState).toBe('MISSING');
  });

  it('delete 事件也是标 MISSING，不删条目', () => {
    const { watcher, records, disk } = harness({ '/w/report.docx': 'v1' });
    watcher.reconcile('/w');
    disk.delete('/w/report.docx');
    watcher.ingestPath('/w/report.docx', 'delete');
    expect(records[0]?.fileState).toBe('MISSING');
  });
});

describe('技能显式上报（信号 ①）走单独入口', () => {
  it('**文件已经被扫进索引了，上报仍能订正类型** —— 而且不产生新版本', () => {
    const { watcher, records } = harness({ '/w/charts/margin.png': 'png-bytes' });
    watcher.reconcile('/w'); // 先按扩展名判成 image
    expect(records[0]?.artifactType).toBe('image');

    const corrected = watcher.ingestSkillReport({
      skill: 'charts',
      path: '/w/charts/margin.png',
      outputFormat: 'png',
      operationKind: 'create',
      title: '季度毛利率',
    });

    expect(records).toHaveLength(1); // 没有 v2
    expect(records[0]?.artifactType).toBe('chart');
    expect(records[0]?.version).toBe(1);
    expect(corrected?.sourceSignal).toBe('SKILL_REPORT');
  });

  it('它带着扩展名推不出来的类型：png 是 chart 不是 image', () => {
    const { watcher } = harness({ '/w/charts/margin.png': 'png-bytes' });
    const record = watcher.ingestSkillReport({
      skill: 'charts',
      path: '/w/charts/margin.png',
      outputFormat: 'png',
      operationKind: 'create',
      title: '季度毛利率',
    });
    expect(record?.artifactType).toBe('chart');
    expect(record?.title).toBe('季度毛利率');
    expect(record?.sourceSignal).toBe('SKILL_REPORT');
  });
});

describe('轮询文件系统：三个平台行为一致、不丢事件', () => {
  it('新增 / 修改 / 删除都能报出来', () => {
    vi.useFakeTimers();
    const disk = new Map<string, string>([['/w/a.txt', 'v1']]);
    const fs = createPollingFileSystem({
      listFiles: () => [...disk.keys()],
      stat: (path) => {
        const content = disk.get(path);
        return content === undefined
          ? undefined
          : { sizeBytes: content.length, contentHash: content };
      },
      intervalMs: 100,
    });

    const events: string[] = [];
    const stop = fs.watch('/w', (path, kind) => events.push(`${kind}:${path}`));

    disk.set('/w/b.txt', 'new');
    vi.advanceTimersByTime(100);
    disk.set('/w/a.txt', 'v2');
    vi.advanceTimersByTime(100);
    disk.delete('/w/b.txt');
    vi.advanceTimersByTime(100);

    expect(events).toEqual(['add:/w/b.txt', 'modify:/w/a.txt', 'delete:/w/b.txt']);
    stop();
    vi.useRealTimers();
  });
});

describe('分享上传', () => {
  const input = {
    shareId: 'sh_1',
    fileName: 'XX公司裁员名单.xlsx',
    bytes: new Uint8Array([1, 2, 3]),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    expiresAt: NOW + 86_400_000,
  };

  function uploader(fetchImpl: typeof globalThis.fetch, logs: Record<string, unknown>[] = []) {
    return {
      logs,
      instance: createUploader(
        { endpoint: 'https://share.evowork.example', token: 'tok' },
        {
          fetch: fetchImpl,
          now: () => NOW,
          logger: recordingLogger(logs),
        },
      ),
    };
  }

  it('成功时返回链接与有效期', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ url: 'https://s/x' }), { status: 200 }),
    );
    const { instance } = uploader(fetchImpl as unknown as typeof globalThis.fetch);
    const result = await instance.upload(input);
    expect(result).toEqual({ ok: true, url: 'https://s/x', expiresAt: input.expiresAt });
  });

  it('**日志里没有文件名** —— 文件名本身可能就是敏感信息', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ url: 'https://s/x' }), { status: 200 }),
    );
    const { instance, logs } = uploader(fetchImpl as unknown as typeof globalThis.fetch);
    await instance.upload(input);
    expect(JSON.stringify(logs)).not.toContain('裁员');
    // 字段名用注册表里已有的 byteSize —— 注册表存在的意义就是"一个概念一个名字"，
    // 自造一个 sizeBytes 会被字段策略直接丢掉（而且是静默丢掉）
    expect(JSON.stringify(logs)).toContain('byteSize');
  });

  it('**上传的也是文件名的 digest**，不是文件名', async () => {
    const seen: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      Object.assign(seen, init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ url: 'https://s/x' }), { status: 200 });
    });
    const { instance } = uploader(fetchImpl as unknown as typeof globalThis.fetch);
    await instance.upload(input);
    expect(seen['x-evowork-name-digest']).toBe(digestName(input.fileName));
    expect(JSON.stringify(seen)).not.toContain('裁员');
  });

  it('**失败即清理云端残留**（断点不续传，不留半截对象）', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'PUT') throw new Error('boom');
      return new Response(null, { status: 204 });
    });
    const { instance } = uploader(fetchImpl as unknown as typeof globalThis.fetch);
    const result = await instance.upload(input);

    expect(result.ok).toBe(false);
    expect(methods).toEqual(['PUT', 'DELETE']);
  });

  it('**取消要真的中止请求**，且文案说清云端不留东西', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        controller.abort();
        throw new Error('aborted');
      }
      return new Response(null, { status: 204 });
    });
    const { instance } = uploader(fetchImpl as unknown as typeof globalThis.fetch);
    const result = await instance.upload(input, { signal: controller.signal });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('类型收窄');
    expect(result.code).toBe('CANCELLED');
    expect(result.message).toContain('云端不会留下');
  });

  it('超上限直接拒绝，**不传一半才发现**', async () => {
    const fetchImpl = vi.fn();
    const { instance } = uploader(fetchImpl as unknown as typeof globalThis.fetch);
    const result = await instance.upload({
      ...input,
      bytes: new Uint8Array(MAX_SHARE_BYTES + 1),
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('密码只上传哈希，不上传明文', () => {
    const hash = hashSharePassword('hunter2', 'sh_1');
    expect(hash).not.toContain('hunter2');
    // 同一密码在不同分享上哈希不同（shareId 参与）
    expect(hashSharePassword('hunter2', 'sh_2')).not.toBe(hash);
  });

  it('撤销走 DELETE', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const { instance } = uploader(fetchImpl as unknown as typeof globalThis.fetch);
    expect(await instance.revoke('sh_1')).toBe(true);
  });
});
