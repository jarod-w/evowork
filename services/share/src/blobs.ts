/**
 * 分享文件的字节存放处。
 *
 * 落盘而不进 sqlite：200MB 的 BLOB 放进行里会让每一次元数据查询都可能把它拖进内存。
 *
 * ## 文件名就是 share id
 *
 * 不带扩展名、不带原始文件名 —— 磁盘上的目录列表也是一处会泄露文件名的地方，
 * 而云端本来就不知道那个名字（见 `schema.ts`）。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ShareBlobs } from './service.js';

/** share id 只允许这套字符：它直接参与拼路径。 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`不安全的 share id：${id}`);
}

export function fileBlobs(dir: string): ShareBlobs {
  const root = resolve(dir);
  return {
    async put(id, bytes) {
      assertSafeId(id);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, id), bytes);
    },
    async read(id) {
      assertSafeId(id);
      try {
        return new Uint8Array(await readFile(join(root, id)));
      } catch {
        return undefined;
      }
    },
    async remove(id) {
      assertSafeId(id);
      await rm(join(root, id), { force: true });
    },
  };
}

/** 测试用。 */
export function memoryBlobs(): ShareBlobs & { readonly map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    put(id, bytes) {
      assertSafeId(id);
      map.set(id, bytes);
      return Promise.resolve();
    },
    read(id) {
      return Promise.resolve(map.get(id));
    },
    remove(id) {
      map.delete(id);
      return Promise.resolve();
    },
  };
}
