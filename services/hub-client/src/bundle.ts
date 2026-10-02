/**
 * 企业离线包（13 §4.7 ③，HUB-Q11=A）：`EVOWORK_HUB_BUNDLE` 指向一个目录，hub-client **只读本地**。
 *
 * 做法是给 hub-client 换一个「fetch」：同一套验签、`sequence`、sha256 原样跑 ——
 * **签名照验**，离线包在内网流转时被改过，同样装不上。这个 fetch 不碰网络：
 * 任何不是 `bundle:` 的地址（例如没写许可条目的上游地址）直接失败，不会退回去联网。
 *
 * ```
 * <dir>/index.json                      我们签的索引原件（离线版单独签较长的有效期）
 * <dir>/pkgs/<kind>/<id>/<ver>.tar.gz   选中条目的内容包
 * <dir>/MANIFEST.json                   打包时间、来源、序号（`scripts/build-hub-bundle.mjs` 写）
 * <dir>/allowlist.json                  可选：企业白名单，只能减、不能加（不需要签名）
 * ```
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { FetchLike } from './client.js';

/** 离线源的地址。真正的路径由 `createBundleFetch` 映射到目录里。 */
export const BUNDLE_BASE_URL = 'bundle://local/v1';

export function createBundleFetch(dir: string): FetchLike {
  const root = resolve(dir);
  return (url) => {
    if (!url.startsWith(`${BUNDLE_BASE_URL}/`)) {
      // 一个字节都不出网：上游地址在离线模式下就是取不到
      return Promise.reject(new Error('离线包模式下不访问网络'));
    }
    // `<base>/<sourceId>/<rest>` → `<dir>/<rest>`
    const rest = url
      .slice(BUNDLE_BASE_URL.length + 1)
      .split('/')
      .slice(1)
      .join('/');
    const full = resolve(root, rest);
    const rel = relative(root, full);
    if (rest === '' || rel.startsWith('..') || rel === '') {
      return Promise.resolve(notFound());
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, rel));
    } catch {
      return Promise.resolve(notFound());
    }
    return Promise.resolve({
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-length' ? String(bytes.length) : null,
      },
      // 拷一份成独立的 ArrayBuffer：Buffer 可能落在共享的池里
      arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
    });
  };
}

function notFound() {
  return {
    status: 404,
    headers: { get: () => null },
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

export interface BundleManifest {
  /** 打包时间（秒）。插件页显示「离线内容，更新于 X」。 */
  readonly builtAt: number;
  readonly sourceId: string;
  readonly sequence: number;
}

export function readBundleManifest(dir: string): BundleManifest | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof raw.builtAt !== 'number' ||
      typeof raw.sourceId !== 'string' ||
      typeof raw.sequence !== 'number'
    ) {
      return undefined;
    }
    return { builtAt: raw.builtAt, sourceId: raw.sourceId, sequence: raw.sequence };
  } catch {
    return undefined;
  }
}

/** 白名单原文。认不出来 = undefined（调用方按「没有白名单」处理 —— 它只能减，不能加）。 */
export function readBundleAllowlist(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, 'allowlist.json'), 'utf8');
  } catch {
    return undefined;
  }
}
