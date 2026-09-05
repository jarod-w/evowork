/**
 * 最小 zip 读取器（08 §3.3 的 ZIP 行，属**基础包** —— 不需要办公扩展）。
 *
 * ## 为什么自己写而不是拉个库
 *
 * 需要的只有两件事：**列出条目**（闸门要用）与**解出条目**。而这条路径是安全敏感的
 * （压缩炸弹、路径穿越都在这里），依赖一个第三方库意味着这两条防线的实现在我们看不见的地方。
 * 中央目录的格式三十年没变，一百行能读完。
 *
 * ## 先列后解，不是边解边查
 *
 * 中央目录里就有每个条目的**解压后大小**，所以炸弹检查可以在解压任何一个字节之前完成。
 * 边解边查的写法在遇到 42KB 解出 4.5PB 的包时已经写出去几个 G 了。
 */
import { inflateRawSync } from 'node:zlib';

import type { ArchiveEntry } from '../gates.js';

const END_OF_CENTRAL_DIR = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export interface ZipEntry extends ArchiveEntry {
  readonly compressionMethod: number;
  readonly compressedBytes: number;
  readonly localHeaderOffset: number;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

/** 读中央目录，列出所有条目。**不解压任何内容**。 */
export function listZipEntries(buffer: Buffer): readonly ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ZipFormatError('中央目录条目的签名不对，文件可能损坏');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const uncompressedBytes = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const path = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({
      path,
      uncompressedBytes,
      compressedBytes,
      compressionMethod,
      localHeaderOffset,
      // 通用位标志的第 0 位 = 加密
      encrypted: (flags & 0x01) === 1,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 解出一个条目。调用方**必须先过 `checkArchive`** —— 这里不重复做闸门。 */
export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new ZipFormatError(`条目 ${entry.path} 的本地头签名不对`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedBytes);

  if (entry.compressionMethod === 0) return Buffer.from(raw); // stored
  if (entry.compressionMethod === 8) return inflateRawSync(raw); // deflate
  throw new ZipFormatError(
    `条目 ${entry.path} 用了不支持的压缩方式（${entry.compressionMethod}）。请解压后再试。`,
  );
}

/** 目录条目（以 `/` 结尾）不是文件，闸门与解析都该跳过。 */
export function isDirectoryEntry(entry: ZipEntry): boolean {
  return entry.path.endsWith('/');
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD 在文件尾部，注释最长 64KB，所以从尾部往前找这么多就够
  const start = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIR) return offset;
  }
  throw new ZipFormatError('找不到中央目录，这可能不是一个 zip 文件，或者文件不完整');
}
