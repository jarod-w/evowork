/**
 * 办公扩展解析器。守的是后果：装了扩展之后拖入 docx，要能拿到 Markdown，
 * 而不是再走「解析失败 / 以原始文件引用」。
 *
 * 包装层用假 Python 脚本测（不看本机有没有办公扩展）。
 * 真解析走办公扩展解释器——有就断言正文，没有就断言返回 undefined，
 * 两条分支都有断言，不靠 skipIf。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MARKDOWN_ROW_LIMIT } from '../src/parsers/builtin.js';
import {
  createOfficeParser,
  resolveOfficeParserScript,
  scriptForExec,
} from '../src/parsers/office.js';
import { createIngest, timestampOf, type UploadStore } from '../src/pipeline.js';
import { resolveOfficeInterpreter } from '../src/probe.js';

const PARSER_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_PARSER = join(PARSER_DIR, '../src/parsers/office.py');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-office-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fsStore(root: string): UploadStore {
  return {
    createUploadDir: (slug, at) => {
      const uploadDir = join(root, `${timestampOf(at)}-${slug}`);
      mkdirSync(uploadDir, { recursive: true });
      return `${uploadDir}/`;
    },
    writeFile: (uploadDir, relativePath, bytes) =>
      writeFileSync(join(uploadDir, relativePath), bytes),
    writeText: (uploadDir, relativePath, text) =>
      writeFileSync(join(uploadDir, relativePath), text, 'utf8'),
  };
}

function writeStub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

const SUCCESS_STUB = [
  'import argparse, json',
  'from pathlib import Path',
  'p = argparse.ArgumentParser()',
  "p.add_argument('--kind'); p.add_argument('--input'); p.add_argument('--out-dir')",
  "p.add_argument('--result'); p.add_argument('--row-limit')",
  'args = p.parse_args()',
  'Path(args.result).write_text(json.dumps({',
  '  "markdown": "# 总体情况\\n本季营收同比增长 18%。\\n",',
  '  "meta": {"parser": "office-docx", "parserVersion": "1", "chars": 18, "tables": 0, "confidence": 1},',
  '  "assets": [],',
  '}), encoding="utf-8")',
].join('\n');

function zipDocx(entries: Record<string, string>): Buffer {
  const path = join(dir, 'fixture.docx');
  execFileSync('python3', [
    '-c',
    [
      'import zipfile,sys,json',
      "z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)",
      'for name,text in json.loads(sys.argv[2]).items(): z.writestr(name,text)',
      'z.close()',
    ].join('\n'),
    path,
    JSON.stringify(entries),
  ]);
  return readFileSync(path);
}

function minimalDocx(): Buffer {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return zipDocx({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/_rels/document.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'word/styles.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${ns}">` +
      '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>' +
      '</w:styles>',
    'word/document.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${ns}"><w:body>` +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>总体情况</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>本季营收同比增长 18%。</w:t></w:r></w:p>' +
      '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
      '<w:tr><w:tc><w:p><w:r><w:t>产品线</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>营收</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>A 线</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>1240 万</w:t></w:r></w:p></w:tc></w:tr>' +
      '</w:tbl></w:body></w:document>',
  });
}

describe('包装层：不依赖办公扩展', () => {
  it('脚本在源码树里能被找到 —— 找不到的话开发期也会解析失败', () => {
    const resolved = resolveOfficeParserScript(
      pathToFileURL(join(PARSER_DIR, '../src/parsers/office.ts')).href,
    );
    expect(resolved).toBe(SRC_PARSER);
    expect(readFileSync(SRC_PARSER, 'utf8')).toContain('--kind');
  });

  it('假解释器跑通后给出 Markdown，而不是 undefined', async () => {
    const original = join(dir, 'original.docx');
    writeFileSync(original, minimalDocx());
    const parser = createOfficeParser({
      interpreter: 'python3',
      scriptPath: writeStub('ok.py', SUCCESS_STUB),
    });
    const result = await parser.parse({
      kind: 'docx',
      absolutePath: original,
      timeoutMs: 10_000,
    });
    expect(result?.markdown).toContain('总体情况');
    expect(result?.meta.parser).toBe('office-docx');
  });

  it('解释器不存在 → undefined，由管道改口成「解析失败」而不是假装成功', async () => {
    const original = join(dir, 'original.docx');
    writeFileSync(original, minimalDocx());
    const parser = createOfficeParser({
      interpreter: join(dir, 'no-such-python'),
      scriptPath: writeStub('ok.py', SUCCESS_STUB),
    });
    await expect(
      parser.parse({ kind: 'docx', absolutePath: original, timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
  });

  it('相对路径不跑解析器 —— 那会让 Python 读到错误的文件', async () => {
    const parser = createOfficeParser({
      interpreter: 'python3',
      scriptPath: writeStub('ok.py', SUCCESS_STUB),
    });
    await expect(
      parser.parse({ kind: 'docx', absolutePath: 'uploads/original.docx', timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
  });

  it('asar 里的脚本会物化到临时目录，否则系统 Python 读不到', () => {
    const asarDir = join(dir, 'app.asar', 'dist');
    mkdirSync(asarDir, { recursive: true });
    const packed = join(asarDir, 'office.py');
    writeFileSync(packed, 'print("ok")');
    const runnable = scriptForExec(packed);
    expect(runnable).not.toBe(packed);
    expect(readFileSync(runnable, 'utf8')).toBe('print("ok")');
  });

  it('子进程拿到的 row-limit 与内置表格上限是同一个数', async () => {
    const original = join(dir, 'original.xlsx');
    writeFileSync(original, 'not-used');
    const seen = join(dir, 'argv.txt');
    const stub = writeStub(
      'echo.py',
      [
        'import argparse, json',
        'from pathlib import Path',
        'p = argparse.ArgumentParser()',
        "p.add_argument('--kind'); p.add_argument('--input'); p.add_argument('--out-dir')",
        "p.add_argument('--result'); p.add_argument('--row-limit')",
        'args = p.parse_args()',
        `Path(${JSON.stringify(seen)}).write_text(args.row_limit)`,
        'Path(args.result).write_text(json.dumps({',
        '  "markdown": "x",',
        '  "meta": {"parser": "office-xlsx", "parserVersion": "1", "chars": 1, "tables": 1, "confidence": 1},',
        '  "assets": [],',
        '}))',
      ].join('\n'),
    );
    const parser = createOfficeParser({ interpreter: 'python3', scriptPath: stub });
    await parser.parse({ kind: 'xlsx', absolutePath: original, timeoutMs: 10_000 });
    expect(readFileSync(seen, 'utf8')).toBe(String(MARKDOWN_ROW_LIMIT));
  });
});

describe('真解析：装了扩展就出正文，没装就承认没解出来', () => {
  it('docx 标题、段落、表格都能进 Markdown', async () => {
    const interpreter = resolveOfficeInterpreter();
    const original = join(dir, 'original.docx');
    writeFileSync(original, minimalDocx());
    const parser = createOfficeParser({
      ...(interpreter ? { interpreter } : { interpreter: join(dir, 'missing-python') }),
      scriptPath: SRC_PARSER,
    });
    const result = await parser.parse({
      kind: 'docx',
      absolutePath: original,
      timeoutMs: 30_000,
    });
    if (!interpreter) {
      expect(result).toBeUndefined();
      return;
    }
    expect(result?.markdown).toContain('# 总体情况');
    expect(result?.markdown).toContain('本季营收同比增长 18%。');
    expect(result?.markdown).toContain('| 产品线 | 营收 |');
    expect(result?.markdown).toContain('A 线');
    expect(result?.meta.tables).toBe(1);
  });

  it('接到管道后，带空格的 docx 文件名不再落到 unparsed', async () => {
    const interpreter = resolveOfficeInterpreter();
    const ingest = createIngest({
      store: fsStore(dir),
      probe: { hasModule: () => interpreter !== undefined },
      externalParser: createOfficeParser({
        ...(interpreter ? { interpreter } : { interpreter: join(dir, 'missing-python') }),
        scriptPath: SRC_PARSER,
      }),
    });
    const [outcome] = await ingest.ingest([
      { fileName: '姚老师-AI落地服务方案 .docx', bytes: new Uint8Array(minimalDocx()) },
    ]);
    if (!interpreter) {
      expect(outcome?.status).toBe('runtime-missing');
      return;
    }
    expect(outcome?.status).toBe('parsed');
    if (outcome?.status !== 'parsed') throw new Error('类型收窄');
    expect(outcome.result.markdown).toContain('总体情况');
    expect(outcome.injection.some((item) => item.type === 'text')).toBe(true);
  });
});

describe('K6：解析脚本自己也不能出网', () => {
  it('office.py 不出现网络客户端', () => {
    const source = readFileSync(SRC_PARSER, 'utf8');
    for (const forbidden of [
      'import urllib',
      'from urllib',
      'import requests',
      'import http.client',
      'import httpx',
      'import aiohttp',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
