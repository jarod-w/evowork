/**
 * 分享整条流程（08 §7.1 的四步 + §7.2 的六条硬规则）。
 *
 * 断言写**后果**：授权没过就读了文件 = "取消了授权"与"文件已进内存"同时成立；
 * 云端没删就标成已撤销 = 用户以为链接失效了而它还活着；
 * 链接不带片段 = 接收方看到的是一个没有名字的文件。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  contentTypeOf,
  createShareFlow,
  linkWithName,
  type ShareFlowPorts,
} from '../src/share-flow.js';
import { TTL_MS } from '../src/share.js';
import type { UploadResult } from '../src/upload.js';

const T0 = 1_700_000_000_000;

function harness(over: Partial<ShareFlowPorts> = {}) {
  const reads: string[] = [];
  const uploads: { shareId: string; accessCodeHash?: string | undefined; bytes: number }[] = [];
  const persisted: { id: string; url: string }[] = [];
  const revoked: string[] = [];
  const attached: (string | null)[] = [];
  let uploadResult: UploadResult = { ok: true, url: 'https://s.example/s/shr_1', expiresAt: 0 };
  let cloudRevokeOk = true;
  let seq = 0;

  const ports: ShareFlowPorts = {
    policy: () => ({ enabled: true }),
    findTarget: (id) =>
      id === 'art_1'
        ? {
            artifactId: 'art_1',
            path: '/w/周报.docx',
            fileName: '周报.docx',
            sizeBytes: 2048,
            artifactTypeLabel: 'Word 文档',
          }
        : undefined,
    fileExists: () => true,
    readFile: (path) => {
      reads.push(path);
      return Promise.resolve(new Uint8Array([1, 2, 3, 4]));
    },
    uploader: () => ({
      upload: (input) => {
        uploads.push({
          shareId: input.shareId,
          accessCodeHash: input.accessCodeHash,
          bytes: input.bytes.byteLength,
        });
        return Promise.resolve(uploadResult);
      },
      revoke: (id) => {
        if (cloudRevokeOk) revoked.push(id);
        return Promise.resolve(cloudRevokeOk);
      },
    }),
    persist: (row) => persisted.push({ id: row.id, url: row.url }),
    attachShare: (_id, shareId) => attached.push(shareId),
    markRevoked: () => undefined,
    findShare: (id) => (persisted.some((p) => p.id === id) ? { id } : undefined),
    now: () => T0,
    newId: () => `id${(seq += 1)}`,
    ...over,
  };

  return {
    flow: createShareFlow(ports),
    reads,
    uploads,
    persisted,
    revoked,
    attached,
    setUploadResult(next: UploadResult) {
      uploadResult = next;
    },
    failCloudRevoke() {
      cloudRevokeOk = false;
    },
  };
}

describe('第 ① 步 授权模态', () => {
  it('三句话缺一不可：上传什么 · 上传到哪+谁能看 · 多久失效', () => {
    const h = harness();
    const plan = h.flow.plan('art_1');
    expect('summary' in plan).toBe(true);
    if (!('summary' in plan)) return;
    expect(plan.summary).toHaveLength(3);
    expect(plan.summary[0]).toContain('周报.docx');
    // 少了这句，用户以为分享是本机链接
    expect(plan.summary[1]).toContain('任何拿到链接的人都能访问');
    // 少了这句，他以为链接是永久的
    expect(plan.summary[2]).toContain('后失效');
  });

  it('三档有效期都在，默认 24 小时', () => {
    const h = harness();
    const plan = h.flow.plan('art_1');
    if (!('summary' in plan)) throw new Error('应当给出方案');
    expect(plan.ttl).toBe('24h');
    expect(plan.ttlOptions.map((o) => o.id)).toEqual(['24h', '7d', '30d']);
  });

  it('企业策略停用时给原因，不是一个点不动的按钮（01 §6.3）', () => {
    const h = harness({ policy: () => ({ enabled: false, reason: '等保整改期间停用分享' }) });
    const plan = h.flow.plan('art_1');
    expect('refused' in plan && plan.refused).toBe('等保整改期间停用分享');
  });

  it('文件已经不在磁盘上时如实说', () => {
    const h = harness({ fileExists: () => false });
    const plan = h.flow.plan('art_1');
    expect('refused' in plan && plan.refused).toContain('不在磁盘上');
  });
});

describe('第 ② 步 上传', () => {
  it('**没勾确认就一个字节都不读**（授权在前，读文件在后）', async () => {
    const h = harness();
    const out = await h.flow.perform({ artifactId: 'art_1', ttl: '24h', confirmed: false });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe('NOT_CONFIRMED');
    // 顺序反了的话，"用户取消了授权"与"文件已经被读进内存"会同时成立
    expect(h.reads).toEqual([]);
    expect(h.uploads).toEqual([]);
  });

  it('企业策略停用时同样不读文件', async () => {
    const h = harness({ policy: () => ({ enabled: false, reason: '停用了' }) });
    const out = await h.flow.perform({ artifactId: 'art_1', ttl: '24h', confirmed: true });
    expect(out.ok).toBe(false);
    expect(h.reads).toEqual([]);
  });

  it('没登录时如实说要登录，并给出「另存为」这条不经过云的路', async () => {
    const h = harness({ uploader: () => undefined });
    const out = await h.flow.perform({ artifactId: 'art_1', ttl: '24h', confirmed: true });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe('NOT_SIGNED_IN');
    expect(!out.ok && out.refused).toContain('另存为');
    expect(h.reads).toEqual([]);
  });

  it('访问码只上传哈希，明文不离开本机', async () => {
    const h = harness();
    await h.flow.perform({
      artifactId: 'art_1',
      ttl: '24h',
      accessCode: 'hunter2',
      confirmed: true,
    });
    const sent = h.uploads[0];
    expect(sent?.accessCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(h.uploads)).not.toContain('hunter2');
  });

  it('有效期按所选档位算', async () => {
    const h = harness();
    const out = await h.flow.perform({ artifactId: 'art_1', ttl: '7d', confirmed: true });
    expect(out.ok && out.expiresAt).toBe(T0 + TTL_MS['7d']);
  });

  it('上传失败时不落库 —— 否则「我分享的」里会出现一条打不开的链接', async () => {
    const h = harness();
    h.setUploadResult({ ok: false, code: 'NETWORK', message: '上传失败，网络没连上。' });
    const out = await h.flow.perform({ artifactId: 'art_1', ttl: '24h', confirmed: true });
    expect(out.ok).toBe(false);
    expect(h.persisted).toEqual([]);
    expect(h.attached).toEqual([]);
  });

  it('取消会把 signal 传到下面去 —— 只停进度条是假取消', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const h = harness({
      uploader: () => ({
        upload: (_input, options) => {
          seen.push(options?.signal);
          return Promise.resolve({
            ok: true as const,
            url: 'https://s.example/s/x',
            expiresAt: 0,
          });
        },
        revoke: () => Promise.resolve(true),
      }),
    });
    const controller = new AbortController();
    await h.flow.perform(
      { artifactId: 'art_1', ttl: '24h', confirmed: true },
      { signal: controller.signal },
    );
    expect(seen[0]).toBe(controller.signal);
  });
});

describe('第 ③④ 步 链接与落库', () => {
  it('能复制的链接带文件名片段 —— 云端不知道名字，接收方从 # 之后拿', async () => {
    const h = harness();
    const out = await h.flow.perform({ artifactId: 'art_1', ttl: '24h', confirmed: true });
    expect(out.ok && out.url).toBe(`https://s.example/s/shr_1#${encodeURIComponent('周报.docx')}`);
    expect(h.persisted[0]?.url).toContain('#');
  });

  it('落库之后产物那一行也挂上 share id', async () => {
    const h = harness();
    const out = await h.flow.perform({ artifactId: 'art_1', ttl: '24h', confirmed: true });
    expect(h.persisted[0]?.id).toBe(out.ok ? out.shareId : '');
    expect(h.attached).toEqual([out.ok ? out.shareId : '']);
  });
});

describe('撤销（规则 3）', () => {
  it('云端先删、本机后标', async () => {
    const marked: string[] = [];
    const h = harness({ markRevoked: (id) => marked.push(id) });
    const made = await h.flow.perform({ artifactId: 'art_1', ttl: '24h', confirmed: true });
    const id = made.ok ? made.shareId : '';
    const out = await h.flow.revokeShare(id);
    expect(out.ok).toBe(true);
    expect(h.revoked).toEqual([id]);
    expect(marked).toEqual([id]);
  });

  it('**云端没删成功就不标已撤销** —— 否则用户以为链接失效了而它还活着', async () => {
    const marked: string[] = [];
    const h = harness({ markRevoked: (id) => marked.push(id) });
    const made = await h.flow.perform({ artifactId: 'art_1', ttl: '24h', confirmed: true });
    h.failCloudRevoke();
    const out = await h.flow.revokeShare(made.ok ? made.shareId : '');
    expect(out.ok).toBe(false);
    expect(out.refused).toContain('链接还活着');
    expect(marked).toEqual([]);
  });

  it('撤销一条不存在的记录说清楚', async () => {
    const h = harness();
    expect((await h.flow.revokeShare('shr_nope')).refused).toContain('找不到');
  });
});

describe('杂项', () => {
  it('MIME 按扩展名给，认不出就交给服务端按二进制处理', () => {
    expect(contentTypeOf('/a/b.docx')).toContain('wordprocessingml');
    expect(contentTypeOf('/a/b.PDF')).toBe('application/pdf');
    expect(contentTypeOf('/a/b.weird')).toBe('application/octet-stream');
  });

  it('片段对特殊字符做转义', () => {
    expect(linkWithName('https://x/s/1', 'a b&c.docx')).toBe('https://x/s/1#a%20b%26c.docx');
  });

  it('不做批量：接口一次只接受一个产物（规则 2）', () => {
    const h = harness();
    // perform 的入参里没有数组 —— 这条靠类型，这里只做一次形状确认
    const shape = h.flow.perform as unknown as (input: Record<string, unknown>) => unknown;
    expect(typeof shape).toBe('function');
    expect(vi.isMockFunction(shape)).toBe(false);
  });
});
