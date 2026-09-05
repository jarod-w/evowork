/**
 * 管道编排（08 §3.2）与内置解析器（§3.3 的基础包那几行）。
 *
 * 最重要的两条断言在最后两组：**注入载荷里没有全文**（否则长文档会炸上下文），
 * 以及**这个模块里没有任何出网调用**（K6/Q3 的硬约束，没有云端兜底）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildInjection, summarize } from '../src/inject.js';
import {
  inferColumnTypes,
  parseDelimited,
  parseJson,
  splitDelimited,
} from '../src/parsers/builtin.js';
import { listZipEntries } from '../src/parsers/zip.js';
import { createIngest, slugify, timestampOf, type UploadStore } from '../src/pipeline.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 内存版落盘：测试只关心"写了什么"，不关心写到哪个真实目录。 */
function memoryStore(): UploadStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    createUploadDir: (slug, at) => `uploads/${timestampOf(at)}-${slug}/`,
    writeFile: (dir, name, bytes) => files.set(`${dir}${name}`, `<${bytes.byteLength} bytes>`),
    writeText: (dir, name, text) => files.set(`${dir}${name}`, text),
  };
}

const ALL_INSTALLED = { hasModule: () => true };
const NOTHING_INSTALLED = { hasModule: () => false };

describe('内置解析器：基础包（不需要任何扩展）', () => {
  it('csv → Markdown 表格 + 列类型推断', () => {
    const result = parseDelimited(
      encode('产品,金额,日期\nA,100,2026-01-01\nB,200,2026-02-01'),
      ',',
    );
    expect(result.markdown).toContain('| 产品 | 金额 | 日期 |');
    expect(result.markdown).toContain('列类型：产品=text、金额=number、日期=date');
    expect(result.meta.confidence).toBe(1);
  });

  it('**截断必须说出来**，否则 agent 会以为看到了全部数据然后算错总数', () => {
    const rows = Array.from({ length: 250 }, (_, i) => `行${i},${i}`).join('\n');
    const result = parseDelimited(encode(`名称,值\n${rows}`), ',');
    expect(result.markdown).toContain('只显示前 200 行，共 250 行');
  });

  it('引号里的逗号与换行不算分隔', () => {
    expect(splitDelimited('a,"b,c",d', ',')).toEqual([['a', 'b,c', 'd']]);
    expect(splitDelimited('a,"多\n行",c', ',')).toEqual([['a', '多\n行', 'c']]);
    expect(splitDelimited('a,"说""引号""",c', ',')).toEqual([['a', '说"引号"', 'c']]);
  });

  it('列类型的判据是"全部都像"，不是"多数像"', () => {
    // 一列里混了一个"合计"就不该被当成数值列 —— 下游按数值处理会在那一行炸掉
    expect(inferColumnTypes(1, [['1'], ['2'], ['合计']])).toEqual(['text']);
    expect(inferColumnTypes(1, [['1'], ['2'], ['3']])).toEqual(['number']);
    // 千分位、货币符号、百分号都算数值
    expect(inferColumnTypes(1, [['1,240'], ['¥300'], ['12%']])).toEqual(['number']);
  });

  it('坏 JSON 不是解析失败 —— 原样给出去并标注（agent 常常正是来修它的）', () => {
    const result = parseJson(encode('{ bad json'));
    expect(result.meta.note).toContain('不是合法 JSON');
    expect(result.markdown).toContain('bad json');
  });
});

describe('zip：先列后解', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evowork-zip-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeZip(entries: Record<string, string>): Buffer {
    const script = [
      'import zipfile,sys,json',
      `z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)`,
      `for name,text in json.loads(sys.argv[2]).items(): z.writestr(name,text)`,
      'z.close()',
    ].join('\n');
    const path = join(dir, 'a.zip');
    execFileSync('python3', ['-c', script, path, JSON.stringify(entries)]);
    return readFileSync(path);
  }

  it('读得出条目名与解压后大小（闸门要在解压之前拿到它们）', () => {
    const buffer = makeZip({ 'a.txt': 'hello', 'docs/b.csv': '名称,值\nA,1' });
    const entries = listZipEntries(buffer);
    expect(entries.map((e) => e.path).sort()).toEqual(['a.txt', 'docs/b.csv']);
    expect(entries.find((e) => e.path === 'a.txt')?.uncompressedBytes).toBe(5);
  });

  it('包里的文件被逐个解析（递归，限深度 2）', async () => {
    const store = memoryStore();
    const ingest = createIngest({ store, probe: ALL_INSTALLED });
    const outcomes = await ingest.ingest([
      { fileName: 'bundle.zip', bytes: makeZip({ 'a.csv': '名称,值\nA,1' }) },
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('parsed');
    expect(outcomes[0]?.kind).toBe('csv');
  });

  it('路径穿越 → **整包**被拒（不是跳过那一条）', async () => {
    const store = memoryStore();
    const ingest = createIngest({ store, probe: ALL_INSTALLED });
    const outcomes = await ingest.ingest([
      { fileName: 'evil.zip', bytes: makeZip({ 'ok.txt': 'x', '../escape.txt': 'y' }) },
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('rejected');
    // 一条都没解出来
    expect([...store.files.keys()].filter((k) => k.includes('escape'))).toHaveLength(0);
  });
});

describe('运行时缺失时给两个出路（03 §8），**没有云端兜底**（K6）', () => {
  it('没装办公扩展 → runtime-missing + refer-as-raw，而不是"传到云上解析"', async () => {
    const store = memoryStore();
    const ingest = createIngest({ store, probe: NOTHING_INSTALLED });
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const [outcome] = await ingest.ingest([{ fileName: '年报.pdf', bytes: pdf }]);

    expect(outcome?.status).toBe('runtime-missing');
    if (outcome?.status !== 'runtime-missing') throw new Error('类型收窄');
    expect(outcome.fallback).toBe('refer-as-raw');
    expect(outcome.message).toContain('办公扩展');
    // 没装扩展就不该先把文件落盘（用户可能选择"以原始文件引用"，那时才需要）
    expect(store.files.size).toBe(0);
  });

  it('基础包的类型不受影响 —— 什么都没装也能处理 csv', async () => {
    const ingest = createIngest({ store: memoryStore(), probe: NOTHING_INSTALLED });
    const [outcome] = await ingest.ingest([{ fileName: 'a.csv', bytes: encode('名称,值\nA,1') }]);
    expect(outcome?.status).toBe('parsed');
  });

  it('外部解析器返回 undefined（装了一半）也走同一条降级路径', async () => {
    const ingest = createIngest({
      store: memoryStore(),
      probe: ALL_INSTALLED,
      externalParser: { parse: vi.fn(async () => undefined) },
    });
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
    const [outcome] = await ingest.ingest([{ fileName: 'a.pdf', bytes: pdf }]);
    expect(outcome?.status).toBe('runtime-missing');
  });
});

describe('不解析这条路（08 §3.3 最后两行）', () => {
  it('代码文件 → Mention，不进解析器', async () => {
    const ingest = createIngest({ store: memoryStore(), probe: ALL_INSTALLED });
    const [outcome] = await ingest.ingest([{ fileName: 'main.rs', bytes: encode('fn main(){}') }]);
    if (outcome?.status !== 'passthrough') throw new Error('应该走不解析这条路');
    expect(outcome.injection[0]?.type).toBe('mention');
  });

  it('图片 → LocalImage', async () => {
    const ingest = createIngest({ store: memoryStore(), probe: ALL_INSTALLED });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const [outcome] = await ingest.ingest([{ fileName: 'shot.png', bytes: png }]);
    if (outcome?.status !== 'passthrough') throw new Error('应该走不解析这条路');
    expect(outcome.injection[0]?.type).toBe('localImage');
  });
});

describe('**注入载荷里没有全文**（08 §3.2 第 ⑤ 步 / 总纲 §6.7）', () => {
  const longMarkdown = [
    '# 第一章',
    '这是首段。',
    ...Array.from({ length: 500 }, (_, i) => `第 ${i} 行正文内容`),
  ].join('\n');

  it('给的是路径 + 摘要 + 关键页，不是正文', () => {
    const items = buildInjection({
      fileName: '年报.pdf',
      uploadDir: 'uploads/20260905-年报/',
      result: {
        markdown: longMarkdown,
        meta: {
          parser: 'x',
          parserVersion: '1',
          chars: longMarkdown.length,
          tables: 0,
          confidence: 1,
          pages: 42,
        },
        assets: [],
      },
    });
    const text = items.map((i) => ('text' in i ? i.text : '')).join('');
    expect(text).toContain('uploads/20260905-年报/content.md');
    expect(text).toContain('42 页');
    // 第 499 行绝不该出现在注入里
    expect(text).not.toContain('第 499 行正文内容');
    expect(text.length).toBeLessThan(600);
  });

  it('摘要是**首段 + 标题 + 表格数**，且不调模型（纯字符串处理）', () => {
    const summary = summarize('# 一\n首段文字。\n## 二\n| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(summary).toContain('首段文字。');
    expect(summary).toContain('包含章节：一、二');
    expect(summary).toContain('含 1 张表格');
  });

  it('OCR 置信度低时**如实写进注入文本**，不静默当作正常文本（08 §8）', () => {
    const items = buildInjection({
      fileName: '扫描件.pdf',
      uploadDir: 'uploads/x/',
      result: {
        markdown: '识别出的文字',
        meta: { parser: 'ocr', parserVersion: '1', chars: 6, tables: 0, confidence: 0.4 },
        assets: [],
      },
    });
    const text = items.map((i) => ('text' in i ? i.text : '')).join('');
    expect(text).toContain('扫描件');
    expect(text).toContain('以原件为准');
  });

  it('解析不完整时也如实说', () => {
    const items = buildInjection({
      fileName: 'a.pdf',
      uploadDir: 'uploads/x/',
      result: {
        markdown: 'x',
        meta: {
          parser: 'p',
          parserVersion: '1',
          chars: 1,
          tables: 0,
          confidence: 1,
          partial: true,
        },
        assets: [],
      },
    });
    expect(items.map((i) => ('text' in i ? i.text : '')).join('')).toContain('解析超时');
  });

  it('关键页最多 4 张（08 §3.2）', () => {
    const items = buildInjection({
      fileName: 'a.pdf',
      uploadDir: 'uploads/x/',
      result: {
        markdown: 'x',
        meta: { parser: 'p', parserVersion: '1', chars: 1, tables: 0, confidence: 1 },
        assets: [],
      },
      keyImages: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'],
    });
    expect(items.filter((i) => i.type === 'localImage')).toHaveLength(4);
  });
});

describe('K6：这个模块里**没有出网路径**', () => {
  it('源码里不出现 fetch / http 请求 —— 云端兜底不存在，不是"默认关闭"', () => {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const files = [
      'pipeline.ts',
      'inject.ts',
      'runtime.ts',
      'gates.ts',
      'detect.ts',
      'parsers/builtin.ts',
      'parsers/zip.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(srcDir, file), 'utf8').replace(
        /\/\*[\s\S]*?\*\/|\/\/.*/g,
        '',
      );
      for (const forbidden of [
        'fetch(',
        'node:http',
        'node:https',
        'XMLHttpRequest',
        'WebSocket',
      ]) {
        expect(source, `${file} 不该出现 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('落盘路径', () => {
  it('slug 去掉扩展名与非法字符，空标题也有兜底', () => {
    expect(slugify('2026 年报/终版.pdf')).toBe('2026-年报-终版');
    expect(slugify('.gitignore')).toBe('file');
  });

  it('时间戳格式是 yyyymmdd-hhmmss', () => {
    expect(timestampOf(new Date(2026, 8, 5, 9, 3, 7))).toBe('20260905-090307');
  });
});
