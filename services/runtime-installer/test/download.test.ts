import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { downloadAsset, DownloadError } from '../src/download.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'evowork-download-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function assetOf(body: string, sha256?: string) {
  return {
    url: 'https://example.invalid/thing.tar.gz',
    sha256: sha256 ?? createHash('sha256').update(body).digest('hex'),
    bytes: Buffer.byteLength(body),
  };
}

function respondWith(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;
}

describe('下载与校验', () => {
  it('哈希对得上就落盘', async () => {
    const dest = join(dir, 'ok.bin');
    await downloadAsset(assetOf('hello'), dest, { fetchFn: respondWith('hello') });
    expect(readFileSync(dest, 'utf8')).toBe('hello');
  });

  /**
   * 这条守的是安装器最危险的一个分支：**校验失败不能留下半截文件**。
   * 留下的话下一次安装可能直接拿它用，而那时候已经没人知道它是坏的了。
   */
  it('哈希对不上：删掉文件并报 CHECKSUM，不留残骸', async () => {
    const dest = join(dir, 'bad.bin');
    const asset = assetOf('hello', 'f'.repeat(64));
    await expect(
      downloadAsset(asset, dest, { fetchFn: respondWith('hello') }),
    ).rejects.toBeInstanceOf(DownloadError);
    expect(existsSync(dest), '坏文件必须被删掉').toBe(false);
  });

  it('校验失败的文案不劝人重试 —— 重试只会再下一遍同样的东西', async () => {
    const asset = assetOf('hello', 'f'.repeat(64));
    const err = await downloadAsset(asset, join(dir, 'x'), {
      fetchFn: respondWith('hello'),
    }).catch((e: unknown) => e as DownloadError);
    expect(err.failure).toBe('CHECKSUM');
    expect(err.message).toContain('离线');
  });

  it('HTTP 错误带上状态码 —— 403 多半是公司代理，404 是清单过期，处理方式不同', async () => {
    const err = await downloadAsset(assetOf('x'), join(dir, 'y'), {
      fetchFn: respondWith('', { status: 403 }),
    }).catch((e: unknown) => e as DownloadError);
    expect(err.failure).toBe('HTTP_STATUS');
    expect(err.message).toContain('403');
  });

  it('连不上时报 NETWORK，不报成校验失败', async () => {
    const fetchFn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const err = await downloadAsset(assetOf('x'), join(dir, 'z'), { fetchFn }).catch(
      (e: unknown) => e as DownloadError,
    );
    expect(err.failure).toBe('NETWORK');
  });

  /**
   * 卡住的连接必须失败，**不能永远等下去**。
   *
   * 2026-09-07 的真机 E2E 撞到过：连接在 0% 上挂住，15 分钟后测试超时退出，
   * 而这期间进度条一直停在 `0.0 / 25.1 MB`。放到用户那里就是"点了安装永远卡在 0%"——
   * 没有报错、没有出路、也不知道该等还是该重来。
   */
  it('一直不来数据 → STALLED，而不是永远挂着', async () => {
    // 一个永远不结束、也永远不给数据的响应体
    const neverEnds = new ReadableStream<Uint8Array>({ start: () => undefined });
    const fetchFn = (async () =>
      new Response(neverEnds, { status: 200 })) as unknown as typeof fetch;

    const err = await downloadAsset(assetOf('x'), join(dir, 'stall.bin'), {
      fetchFn,
      stallTimeoutMs: 120,
    }).catch((e: unknown) => e as DownloadError);

    expect(err.failure).toBe('STALLED');
    expect(err.message).toContain('离线');
    expect(existsSync(join(dir, 'stall.bin')), '半截文件不能留下').toBe(false);
  });

  it('慢但有数据的连接不该被误杀 —— 慢网下大文件是正常的', async () => {
    let pushed = 0;
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // 每次间隔都短于停滞阈值：这条连接慢，但活着
        await new Promise((r) => setTimeout(r, 40));
        if (pushed++ < 4) controller.enqueue(new TextEncoder().encode('ab'));
        else controller.close();
      },
    });
    const fetchFn = (async () => new Response(slow, { status: 200 })) as unknown as typeof fetch;

    await downloadAsset(assetOf('abababab'), join(dir, 'slow.bin'), {
      fetchFn,
      stallTimeoutMs: 150,
    });
    expect(readFileSync(join(dir, 'slow.bin'), 'utf8')).toBe('abababab');
  });

  it('进度回调按字节递增，最后一次等于总大小', async () => {
    const seen: number[] = [];
    await downloadAsset(assetOf('abcdefghij'), join(dir, 'p.bin'), {
      fetchFn: respondWith('abcdefghij'),
      onBytes: (n) => seen.push(n),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(10);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});
