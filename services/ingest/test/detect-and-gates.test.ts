/**
 * 类型识别与闸门（08 §3.2 ① / §3.4）。
 *
 * 这两块的共同点是**错了不会立刻显形**：类型认错的表现是"模型收到一堆乱码然后瞎答"，
 * 闸门漏了的表现是磁盘被一个 42KB 的文件写满。
 */
import { describe, expect, it } from 'vitest';

import {
  classifyZipContainer,
  detectKind,
  isValidUtf8,
  looksLikeText,
  sniffEncoding,
} from '../src/detect.js';
import {
  checkArchive,
  checkDiskSpace,
  checkFileSize,
  checkUploadCount,
  isPathTraversal,
  LIMITS,
} from '../src/gates.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('magic bytes 优先，扩展名兜底', () => {
  it('改了扩展名的 PDF 仍然被认成 PDF', () => {
    expect(detectKind({ fileName: '合同.txt', head: bytes(0x25, 0x50, 0x44, 0x46, 0x2d) })).toBe(
      'pdf',
    );
  });

  it('没有扩展名的 PNG 仍然被认成图片', () => {
    expect(detectKind({ fileName: 'clipboard', head: bytes(0x89, 0x50, 0x4e, 0x47) })).toBe(
      'image',
    );
  });

  it('**Office 三件套与 zip 同头**，靠内部条目区分', () => {
    const head = bytes(0x50, 0x4b, 0x03, 0x04);
    expect(detectKind({ fileName: 'a.bin', head, zipEntries: ['word/document.xml'] })).toBe('docx');
    expect(detectKind({ fileName: 'a.bin', head, zipEntries: ['xl/workbook.xml'] })).toBe('xlsx');
    expect(detectKind({ fileName: 'a.bin', head, zipEntries: ['ppt/presentation.xml'] })).toBe(
      'pptx',
    );
    expect(detectKind({ fileName: 'a.bin', head, zipEntries: ['photos/1.jpg'] })).toBe('zip');
  });

  it('拿不到内部条目时退回扩展名（拖入瞬间还没读整个文件）', () => {
    const head = bytes(0x50, 0x4b, 0x03, 0x04);
    expect(detectKind({ fileName: '报表.xlsx', head })).toBe('xlsx');
    expect(detectKind({ fileName: '照片.zip', head })).toBe('zip');
  });

  it('代码文件走 code（不解析，agent 用 shell 读）', () => {
    expect(detectKind({ fileName: 'main.rs', head: ascii('fn main() {}') })).toBe('code');
    expect(detectKind({ fileName: 'a.py', head: ascii('print(1)') })).toBe('code');
  });

  it('认不出来但看着是文本 → 按 txt 处理，比拒绝好', () => {
    expect(detectKind({ fileName: 'notes.dat', head: ascii('第一行\n第二行') })).toBe('txt');
  });

  it('认不出来且是二进制 → unknown', () => {
    expect(detectKind({ fileName: 'blob.dat', head: bytes(0x01, 0x00, 0x02, 0x00) })).toBe(
      'unknown',
    );
  });

  it('classifyZipContainer 只看前缀，不被同名文件骗', () => {
    expect(classifyZipContainer(['docs/word/notes.txt'])).toBe('zip');
  });
});

describe('编码嗅探（GBK 认错的表现是整份中文变乱码）', () => {
  it('BOM 优先', () => {
    expect(sniffEncoding(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('utf-8-bom');
  });

  it('合法 UTF-8 中文 → utf-8', () => {
    expect(sniffEncoding(ascii('产品,金额'))).toBe('utf-8');
  });

  it('GBK 的双字节序列违反 UTF-8 续字节规则 → gbk', () => {
    // “产品” 的 GBK 编码
    expect(sniffEncoding(bytes(0xb2, 0xfa, 0xc6, 0xb7))).toBe('gbk');
  });

  it('末尾被截断的多字节序列不算非法（我们只看文件头）', () => {
    expect(isValidUtf8(bytes(0xe4, 0xba))).toBe(true);
  });

  it('looksLikeText 认 NUL 为二进制', () => {
    expect(looksLikeText(bytes(0x41, 0x00, 0x42))).toBe(false);
    expect(looksLikeText(ascii('hello\tworld\n'))).toBe(true);
  });
});

describe('闸门（08 §3.4）', () => {
  it('单文件超 200MB → 拒绝，且**给出路**而不是只说不行', () => {
    const rejection = checkFileSize(LIMITS.maxFileBytes + 1, '年报.pdf');
    expect(rejection?.code).toBe('FILE_TOO_LARGE');
    expect(rejection?.message).toContain('放进工作空间');
  });

  it('单次超 20 个 → 拒绝多余部分', () => {
    expect(checkUploadCount(21)?.code).toBe('TOO_MANY_FILES');
    expect(checkUploadCount(20)).toBeUndefined();
  });

  it('磁盘不足时**给出还差多少**', () => {
    const rejection = checkDiskSpace(200 * 1024 * 1024, 100 * 1024 * 1024);
    expect(rejection?.message).toContain('100MB');
  });
});

describe('压缩包：两条安全硬规则', () => {
  const entry = (path: string, size = 10) => ({ path, uncompressedBytes: size });

  it('**路径穿越 → 拒绝整包**，不是跳过那一条', () => {
    const rejection = checkArchive([entry('ok.txt'), entry('../../etc/passwd')], 1);
    expect(rejection?.code).toBe('ARCHIVE_PATH_TRAVERSAL');
  });

  it('三种穿越形态都认：相对、绝对、Windows 盘符', () => {
    expect(isPathTraversal('a/../../b')).toBe(true);
    expect(isPathTraversal('/etc/passwd')).toBe(true);
    expect(isPathTraversal('C:\\Windows\\system32')).toBe(true);
    expect(isPathTraversal('docs/2026/report.pdf')).toBe(false);
    // 只查 `..` 子串会误伤这个
    expect(isPathTraversal('my..notes/a.txt')).toBe(false);
  });

  it('**压缩炸弹靠解压后大小拦**，不是靠压缩前大小', () => {
    const bomb = [entry('bomb.bin', 5 * 1024 * 1024 * 1024)];
    expect(checkArchive(bomb, 1)?.code).toBe('ARCHIVE_TOO_LARGE');
  });

  it('文件数与深度也有上限', () => {
    const many = Array.from({ length: 201 }, (_, i) => entry(`f${i}.txt`));
    expect(checkArchive(many, 1)?.code).toBe('ARCHIVE_TOO_MANY_ENTRIES');
    expect(checkArchive([entry('a.txt')], 3)?.code).toBe('ARCHIVE_TOO_DEEP');
  });

  it('加密条目 → 提示输入密码，如实说而不是当成损坏', () => {
    const rejection = checkArchive([{ path: 'a.txt', uncompressedBytes: 1, encrypted: true }], 1);
    expect(rejection?.code).toBe('ENCRYPTED');
    expect(rejection?.message).toContain('不保存');
  });

  it('**穿越比超大更该报**：两者都犯时报穿越', () => {
    const both = [{ path: '../x', uncompressedBytes: 5 * 1024 * 1024 * 1024 }];
    expect(checkArchive(both, 1)?.code).toBe('ARCHIVE_PATH_TRAVERSAL');
  });
});
