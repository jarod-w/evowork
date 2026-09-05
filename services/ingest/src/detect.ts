/**
 * 类型识别（08 §3.2 第 ① 步）：**magic bytes 优先，扩展名兜底**。
 *
 * 为什么这个顺序而不是反过来：用户会把 `.xlsx` 改名成 `.txt`，也会把截图存成 `.dat`。
 * 按扩展名走会在第一种情况下拿一堆二进制当文本喂给模型，在第二种情况下白白拒绝一张图。
 * 而 magic bytes 认错的概率低得多。
 *
 * Office 三件套（docx/xlsx/pptx）与 zip 的 magic bytes **完全一样**（都是 zip 容器），
 * 所以那一步必须再看内部条目名 —— 这是这个文件里唯一不直观的地方。
 */

import type { InputKind } from './runtime.js';

/** 代码文件：不解析，直接 `Mention`，让 agent 用 shell 读（08 §3.3 最后一行）。 */
const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'sql',
  'yaml',
  'yml',
  'toml',
  'ini',
  'gradle',
  'lua',
  'r',
  'scala',
  'vue',
  'svelte',
  'html',
  'css',
  'scss',
]);

const EXTENSION_KIND: Readonly<Record<string, InputKind>> = {
  txt: 'txt',
  log: 'txt',
  md: 'md',
  markdown: 'md',
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  zip: 'zip',
  pdf: 'pdf',
  doc: 'docx',
  docx: 'docx',
  xls: 'xlsx',
  xlsx: 'xlsx',
  ppt: 'pptx',
  pptx: 'pptx',
  rtf: 'rtf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  heic: 'image',
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export interface DetectInput {
  readonly fileName: string;
  /** 文件头若干字节（≥ 512 就够） */
  readonly head: Uint8Array;
  /**
   * zip 容器内的条目名（前若干个）。只有当 magic bytes 判定为 zip 时才需要 ——
   * docx/xlsx/pptx 与普通 zip 的头一模一样，只能靠内部结构区分。
   */
  readonly zipEntries?: readonly string[];
}

export function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index + 1).toLowerCase();
}

/** zip 容器内部结构 → 具体的 Office 类型。 */
export function classifyZipContainer(entries: readonly string[]): InputKind {
  const has = (prefix: string): boolean => entries.some((e) => e.startsWith(prefix));
  if (has('word/')) return 'docx';
  if (has('xl/')) return 'xlsx';
  if (has('ppt/')) return 'pptx';
  return 'zip';
}

export function detectKind(input: DetectInput): InputKind {
  const { head, fileName } = input;
  const extension = extensionOf(fileName);

  // ① magic bytes
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'image'; // PNG
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image'; // JPEG
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'image'; // GIF8
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image'; // RIFF....WEBP
  }
  if (startsWith(head, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'rtf'; // {\rtf
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) {
    // OLE2：老版 .doc/.xls/.ppt。头里分不出是哪一种，只能靠扩展名
    const byExtension = EXTENSION_KIND[extension];
    return byExtension && byExtension !== 'zip' ? byExtension : 'unknown';
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    // zip 容器：Office 三件套与普通 zip 同头，必须看内部条目
    if (input.zipEntries) return classifyZipContainer(input.zipEntries);
    const byExtension = EXTENSION_KIND[extension];
    return byExtension === 'docx' || byExtension === 'xlsx' || byExtension === 'pptx'
      ? byExtension
      : 'zip';
  }

  // ② 扩展名兜底
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  const byExtension = EXTENSION_KIND[extension];
  if (byExtension) return byExtension;

  // ③ 都认不出来：看看是不是纯文本。是的话按 txt 处理比拒绝好
  return looksLikeText(head) ? 'txt' : 'unknown';
}

/**
 * 粗判是不是文本。
 *
 * 判据是"没有 NUL 字节且不可打印字符占比低" —— 对 UTF-8 中文、GBK 中文都成立，
 * 对二进制不成立。比"能不能按 UTF-8 解码"宽容，因为 GBK 文本解不出 UTF-8 但它是文本。
 */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  let suspicious = 0;
  for (const byte of head) {
    if (byte === 0) return false;
    // 允许 \t \n \r 与所有 ≥ 0x20 的字节（含高位的多字节编码）
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) suspicious += 1;
  }
  return suspicious / head.length < 0.05;
}

/**
 * 文本编码嗅探（08 §3.3 的「CSV/TSV：编码嗅探（GBK/UTF-8）」）。
 *
 * 只区分三种，因为国内办公场景里 csv 基本只有这三种：UTF-8（含 BOM）与 GBK 家族。
 * 认错的后果是整份中文变乱码，而用户会以为是我们解析坏了。
 */
export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'gbk';

export function sniffEncoding(head: Uint8Array): TextEncoding {
  if (startsWith(head, [0xef, 0xbb, 0xbf])) return 'utf-8-bom';
  return isValidUtf8(head) ? 'utf-8' : 'gbk';
}

/** UTF-8 合法性检查。非法即认定 GBK —— GBK 的双字节序列几乎必然违反 UTF-8 的续字节规则。 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] as number;
    let length: number;
    if (byte < 0x80) length = 1;
    else if ((byte & 0xe0) === 0xc0) length = 2;
    else if ((byte & 0xf0) === 0xe0) length = 3;
    else if ((byte & 0xf8) === 0xf0) length = 4;
    else return false;

    // 末尾被截断的多字节序列不算错（我们只看了文件头）
    if (index + length > bytes.length) return true;
    for (let offset = 1; offset < length; offset += 1) {
      if (((bytes[index + offset] as number) & 0xc0) !== 0x80) return false;
    }
    index += length;
  }
  return true;
}
