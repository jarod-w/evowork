/**
 * 真实端口：全局 `fetch` + 本机文件。桌面宿主用它；测试注入假的。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { FetchLike, HubClientPorts, HubFs } from './client.js';

export const nodeHubFs: HubFs = {
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  writeTextAtomic(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  },
};

/**
 * 不加任何头：不带 Cookie、不带账号令牌、不带 App 版本（4.6「带什么」）。
 * `credentials` 对 node 的 fetch 没有意义，这里也不传。
 */
export const nodeHubFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: init.headers,
    redirect: init.redirect,
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  });
  return response;
};

export function createNodeHubPorts(input: {
  readonly cacheRoot: string;
  readonly fetch?: FetchLike | undefined;
}): HubClientPorts {
  return {
    fetch: input.fetch ?? nodeHubFetch,
    fs: nodeHubFs,
    cacheRoot: input.cacheRoot,
    now: () => Math.floor(Date.now() / 1000),
  };
}
