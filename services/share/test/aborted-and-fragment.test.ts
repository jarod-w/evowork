/**
 * 两条只有**真服务器**能回答的问题。其余的在 `share.test.ts` / `http.test.ts` 与
 * `services/artifacts/test/share-flow.test.ts` 里已经覆盖了，这里不重复。
 *
 * ① **取消是不是真的中止了请求。** 流程层的测试断言的是"`signal` 传下去了"——
 *    那证明的是我们把参数接对了，证明不了**字节真的停了**。用户关心的是后者：
 *    点了取消之后，云上有没有留下这份文件。
 *
 * ② **`#` 之后的文件名到底进没进请求。** 08 §7.5 把文件名放在片段里，
 *    正是因为片段不上行 —— 云端只有 digest（`no-name-column.test.ts` 守着 DDL）。
 *    但"我们不发它"与"它发不出去"是两件事：前者靠自觉，后者是 HTTP 的事实。
 *    这里让**服务端自己说**它收到的 URL 是什么。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEs256KeyPair, signAccessToken, type AccessClaims } from '@evowork/account';
import { afterEach, describe, expect, it } from 'vitest';

import { memoryBlobs } from '../src/blobs.js';
import { openShareDb } from '../src/db.js';
import { createShareServer } from '../src/http.js';
import { createShareService } from '../src/service.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let baseUrl = '';
let close: () => Promise<void> = async () => undefined;
/** 服务端**实际收到**的每一条请求行。判据要由它说，不由客户端说。 */
let seen: string[] = [];

async function start() {
  const keys = generateEs256KeyPair();
  const service = createShareService({
    db: openShareDb(':memory:'),
    blobs: memoryBlobs(),
    publicOrigin: 'https://s.example',
  });
  const webDir = mkdtempSync(join(tmpdir(), 'evowork-share-'));
  writeFileSync(join(webDir, 'share.html'), '<!doctype html><title>分享</title>');
  const server = createShareServer({ service, publicPem: keys.publicPem, webDir });
  seen = [];
  // 多挂一个监听器就能看到原始请求行；处理逻辑不受影响
  server.on('request', (req) => seen.push(req.url ?? ''));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  const iat = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = {
    sub: 'usr_1',
    tenant: 'ten_1',
    iat,
    exp: iat + 900,
    scope: 'gateway',
    quotaClass: 'default',
    deviceId: 'dev_1',
    role: 'member',
  };
  return { token: signAccessToken(keys.privatePem, claims, keys.kid) };
}

afterEach(async () => {
  await close();
});

describe('取消上传：中止的是请求，不只是进度条', () => {
  it('中途 abort 之后，云端没有留下这份文件', async () => {
    const { token } = await start();
    const controller = new AbortController();

    /*
     * 一个**发一点就挂住**的请求体。真实的取消就长这样：
     * 已经传了一部分、还没传完。若中止只停在客户端，服务端会继续等、
     * 甚至把已收到的部分落库 —— 那正是"假取消"的样子。
     */
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4096));
      },
      pull() {
        // 不再给字节，也不 close：连接就这么挂着
      },
    });

    const pending = fetch(`${baseUrl}/v1/shares`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': DOCX,
        'x-evowork-share-id': 'shr_abort',
        'x-evowork-name-digest': 'd'.repeat(64),
        'x-evowork-expires-at': String(Date.now() + 86_400_000),
      },
      body,
      signal: controller.signal,
      // Node 的 fetch 发流式请求体要它
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toThrow();

    /*
     * **自证**：先确认那个 PUT 真的到过服务端。到不了的话下面那条断言什么都没证明 ——
     * "云上没有这份文件"在"请求压根没发出去"时同样成立。
     */
    expect(
      seen.some((u) => u === '/v1/shares'),
      '上传请求没到过服务端',
    ).toBe(true);

    /*
     * **判据落在云端有没有东西**，不落在客户端抛没抛错。
     * 落了一半的字节同样算失败：一份打不开的 docx 比没有更糟 ——
     * 用户拿着链接以为分享成功了。
     *
     * 断的是 `state` 不是状态码：这些路由**永远回 200**，
     * 「已撤销 / 已过期 / 根本没有」三者形状一致，免得拿链接探测
     * （`http.test.ts` 有一条专门守它）。所以在这里断状态码等于什么都没断 ——
     * 第一版就是这么写的，红得莫名其妙，而产品其实是对的。
     */
    const meta = await fetch(`${baseUrl}/v1/s/shr_abort`);
    const state = ((await meta.json()) as { readonly state?: string }).state;
    expect(state, '中止之后云端竟然留下了这份文件').toBe('missing');

    /*
     * **正向对照。** 上面那句 `missing` 如果是服务端对什么都这么说，这条测试就什么都没证明。
     * 所以正常传一份进去，确认同一个判据会给出不同的答案。
     */
    const ok = await fetch(`${baseUrl}/v1/shares`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': DOCX,
        'x-evowork-share-id': 'shr_control',
        'x-evowork-name-digest': 'd'.repeat(64),
        'x-evowork-expires-at': String(Date.now() + 86_400_000),
      },
      body: new Uint8Array(4096),
    });
    expect(ok.status, '正向对照本身就没传上去').toBe(200);
    const controlState = (
      (await (await fetch(`${baseUrl}/v1/s/shr_control`)).json()) as { readonly state?: string }
    ).state;
    expect(controlState, '传成功的也报 missing —— 这个判据分辨不了任何东西').not.toBe('missing');
  });
});

describe('文件名走片段：它到不了服务端（08 §7.5）', () => {
  it('URL 里的 # 之后那一段，服务端一个字都收不到', async () => {
    await start();
    const secret = '季度奖金明细-张三.xlsx';

    await fetch(`${baseUrl}/v1/s/shr_frag#${encodeURIComponent(secret)}`).catch(() => undefined);

    /*
     * 这条断言的价值不在"片段不上行"这个 HTTP 事实本身 —— 而在于**它是被服务端确认的**。
     * 客户端说"我没发"是自觉；服务端说"我没收到"才是事实。
     * 哪天有人把文件名改成查询参数（看起来只是换个写法），这条会红。
     */
    expect(seen.length, '服务端没收到任何请求，这条断言无从谈起').toBeGreaterThan(0);
    for (const url of seen) {
      expect(url, `服务端收到的 URL 里有文件名：${url}`).not.toContain('季度奖金');
      expect(url).not.toContain(encodeURIComponent(secret));
      expect(url, 'URL 里出现了 # —— 片段本不该上行').not.toContain('#');
    }
  });
});
