/**
 * Q41 的硬规则在服务端这一半。
 *
 * 断言写**后果**：办公文件按真实 MIME 内联下发 = 浏览器会去渲染一份不可信文件；
 * 失效链接回出类型和大小 = 拿链接就能探测；密码错与链接失效分开回 = 可以枚举。
 */
import { describe, expect, it } from 'vitest';

import { memoryBlobs } from '../src/blobs.js';
import { openShareDb } from '../src/db.js';
import { createShareService, PREVIEWABLE_TYPES, sha256Hex } from '../src/service.js';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function harness() {
  let clock = T0;
  const blobs = memoryBlobs();
  const service = createShareService({
    db: openShareDb(':memory:'),
    blobs,
    publicOrigin: 'https://s.example',
    now: () => clock,
  });
  return {
    service,
    blobs,
    advance(ms: number) {
      clock += ms;
    },
    put(over: Partial<Parameters<typeof service.put>[0]> = {}) {
      return service.put({
        id: 'shr_abc',
        ownerSub: 'usr_1',
        tenant: 'ten_1',
        nameDigest: 'deadbeef',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        expiresAt: clock + 24 * HOUR,
        bytes: new Uint8Array([1, 2, 3]),
        ...over,
      });
    },
  };
}

describe('上传与链接', () => {
  it('上传成功回一条 /s/<id> 链接', async () => {
    const h = harness();
    const out = await h.put();
    expect(out.ok && out.url).toBe('https://s.example/s/shr_abc');
  });

  it('别人的 id 不能覆盖', async () => {
    const h = harness();
    await h.put();
    const out = await h.put({ ownerSub: 'usr_2' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.status).toBe(409);
  });

  it('同一个人重传同一个 id 是覆盖，不是冲突 —— 上传失败后会清理再重试', async () => {
    const h = harness();
    await h.put();
    const out = await h.put({ bytes: new Uint8Array([9, 9]) });
    expect(out.ok).toBe(true);
    const got = await h.service.download('shr_abc');
    expect(got.ok && Array.from(got.bytes)).toEqual([9, 9]);
  });

  it('已经过期的有效期不接受', async () => {
    const h = harness();
    const out = await h.put({ expiresAt: T0 - 1 });
    expect(out.ok).toBe(false);
  });
});

describe('接收方看到什么', () => {
  it('有效时给类型、大小、有效期与「能不能预览」', async () => {
    const h = harness();
    await h.put();
    const seen = h.service.describe('shr_abc');
    expect(seen.state).toBe('active');
    expect(seen.meta?.sizeBytes).toBe(3);
    // docx 不可预览 —— 这是 Q41 的原话
    expect(seen.meta?.previewable).toBe(false);
  });

  it('失效之后**只回状态**：类型、大小都不回，免得拿链接探测', async () => {
    const h = harness();
    await h.put();
    h.advance(25 * HOUR);
    const seen = h.service.describe('shr_abc');
    expect(seen.state).toBe('expired');
    expect(seen.meta).toBeUndefined();
  });

  it('「已撤销」「已过期」「根本没有」三者形状一致', async () => {
    const h = harness();
    await h.put();
    await h.service.revoke('shr_abc', 'usr_1');
    const revoked = h.service.describe('shr_abc');
    const missing = h.service.describe('shr_nope');
    expect(revoked.meta).toBeUndefined();
    expect(missing.meta).toBeUndefined();
    expect(Object.keys(revoked)).toEqual(Object.keys(missing));
  });
});

describe('预览安全名单（08 §7.4）', () => {
  it('办公文件一律不可预览', () => {
    for (const type of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword',
      'text/html',
    ]) {
      expect(PREVIEWABLE_TYPES.has(type)).toBe(false);
    }
  });

  it('SVG 不在名单里 —— 它是能带脚本的 XML，浏览器会当文档跑', () => {
    expect(PREVIEWABLE_TYPES.has('image/svg+xml')).toBe(false);
  });

  it('图片与 PDF 可以预览', () => {
    expect(PREVIEWABLE_TYPES.has('image/png')).toBe(true);
    expect(PREVIEWABLE_TYPES.has('application/pdf')).toBe(true);
  });
});

describe('访问密码', () => {
  it('密码只挡住拿文件，**不因此开通办公文件预览**', async () => {
    const h = harness();
    const hash = sha256Hex('shr_abc:hunter2');
    await h.put({ passwordHash: hash });

    const locked = await h.service.download('shr_abc');
    expect(locked.ok).toBe(false);
    expect(!locked.ok && locked.state).toBe('locked');

    const unlocked = h.service.unlock('shr_abc', hash);
    expect(unlocked.ok).toBe(true);
    const got = await h.service.download('shr_abc', unlocked.ok ? unlocked.grant : '');
    expect(got.ok).toBe(true);
    // 解锁之后它依然是不可预览的 docx
    expect(got.ok && got.previewable).toBe(false);
  });

  it('密码错与链接失效回的是同一种失败，不能拿来枚举', async () => {
    const h = harness();
    await h.put({ passwordHash: sha256Hex('shr_abc:right') });
    expect(h.service.unlock('shr_abc', sha256Hex('shr_abc:wrong')).ok).toBe(false);
    expect(h.service.unlock('shr_nope', sha256Hex('x')).ok).toBe(false);
  });

  it('凭据认 share，换一个 id 用不了', async () => {
    const h = harness();
    const hash = sha256Hex('shr_abc:pw');
    await h.put({ passwordHash: hash });
    await h.put({ id: 'shr_other', passwordHash: hash });
    const grant = h.service.unlock('shr_abc', hash);
    const cross = await h.service.download('shr_other', grant.ok ? grant.grant : '');
    expect(cross.ok).toBe(false);
  });

  it('凭据会过期', async () => {
    const h = harness();
    const hash = sha256Hex('shr_abc:pw');
    await h.put({ passwordHash: hash });
    const grant = h.service.unlock('shr_abc', hash);
    h.advance(11 * 60 * 1000);
    const late = await h.service.download('shr_abc', grant.ok ? grant.grant : '');
    expect(late.ok).toBe(false);
  });
});

describe('撤销与到期', () => {
  it('撤销立刻删字节，但留一行墓碑 —— 接收方要看到「已撤销」而不是 404', async () => {
    const h = harness();
    await h.put();
    await h.service.revoke('shr_abc', 'usr_1');
    expect(h.blobs.map.has('shr_abc')).toBe(false);
    expect(h.service.describe('shr_abc').state).toBe('revoked');
  });

  it('不是自己的分享撤不掉', async () => {
    const h = harness();
    await h.put();
    expect(await h.service.revoke('shr_abc', 'usr_2')).toBe(false);
    expect(h.service.describe('shr_abc').state).toBe('active');
  });

  it('到期清扫删字节、留状态', async () => {
    const h = harness();
    await h.put();
    h.advance(25 * HOUR);
    const swept = await h.service.sweep();
    expect(swept.removed).toBe(1);
    expect(h.blobs.map.has('shr_abc')).toBe(false);
    expect(h.service.describe('shr_abc').state).toBe('expired');
  });

  it('撤销之后旧凭据立刻作废', async () => {
    const h = harness();
    const hash = sha256Hex('shr_abc:pw');
    await h.put({ passwordHash: hash });
    const grant = h.service.unlock('shr_abc', hash);
    await h.service.revoke('shr_abc', 'usr_1');
    const after = await h.service.download('shr_abc', grant.ok ? grant.grant : '');
    expect(after.ok).toBe(false);
  });
});

describe('访问次数', () => {
  it('每下一次加一，且只有分享者本人能看', async () => {
    const h = harness();
    await h.put();
    await h.service.download('shr_abc');
    await h.service.download('shr_abc');
    expect(h.service.visits('shr_abc', 'usr_1')).toBe(2);
    expect(h.service.visits('shr_abc', 'usr_2')).toBeUndefined();
  });
});
