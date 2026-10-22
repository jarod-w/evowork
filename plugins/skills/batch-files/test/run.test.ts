import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXIT,
  WITHOUT_OFFICE_RUNTIME,
  makeTempDir,
  parseFailure,
  removeDir,
  runPython,
  writeContent,
} from '../../_shared/test-helpers.js';

const RUN = resolve(dirname(fileURLToPath(import.meta.url)), '../container_tools/run.py');

let dir: string;
let ws: string;
beforeEach(() => {
  dir = makeTempDir('evowork-batch-');
  ws = join(dir, 'ws');
  mkdirSync(ws);
});
afterEach(() => removeDir(dir));

function run(content: unknown, env: Readonly<Record<string, string>> = {}) {
  return runPython(
    RUN,
    ['--content', writeContent(dir, content), '--out', join(dir, 'report.json')],
    env,
  );
}

describe('只在工作区里移动', () => {
  it('重命名会挪走原文件', () => {
    writeFileSync(join(ws, '草稿.txt'), '周报');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [{ from: '草稿.txt', to: '周报.txt' }],
    });
    expect(result.status).toBe(EXIT.ok);
    expect(existsSync(join(ws, '草稿.txt'))).toBe(false);
    expect(readFileSync(join(ws, '周报.txt'), 'utf8')).toBe('周报');
  });

  it('目标已存在时一个都不改', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    writeFileSync(join(ws, 'b.txt'), 'b');
    writeFileSync(join(ws, 'taken.txt'), 'taken');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [
        { from: 'a.txt', to: 'a2.txt' },
        { from: 'b.txt', to: 'taken.txt' },
      ],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(existsSync(join(ws, 'a.txt'))).toBe(true);
    expect(existsSync(join(ws, 'a2.txt'))).toBe(false);
    expect(readFileSync(join(ws, 'taken.txt'), 'utf8')).toBe('taken');
  });

  it('超出 50 个时拒绝，不截断着改', () => {
    const items = [];
    for (let index = 0; index < 51; index += 1) {
      writeFileSync(join(ws, `f${index}.txt`), 'x');
      items.push({ from: `f${index}.txt`, to: `g${index}.txt` });
    }
    const result = run({ operation: 'rename', workspace: ws, items });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('50');
    expect(existsSync(join(ws, 'f0.txt'))).toBe(true);
    expect(existsSync(join(ws, 'g0.txt'))).toBe(false);
  });

  it('拒绝跳出工作区，工作区外的文件保持原样', () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [{ from: 'a.txt', to: '../outside/secret.txt' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a');
  });

  it('绝对路径指向工作区外时拒绝', () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [{ from: 'a.txt', to: join(outside, 'secret.txt') }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a');
  });

  it('路径经过符号链接目录时拒绝', () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(ws, 'linked'));
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [{ from: 'a.txt', to: 'linked/a.txt' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('符号链接');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a');
    expect(existsSync(join(outside, 'a.txt'))).toBe(false);
  });

  it('不跟随符号链接', () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'secret.txt'));
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [{ from: 'secret.txt', to: 'copied.txt' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('符号链接');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(lstatSync(join(ws, 'secret.txt')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(ws, 'copied.txt'))).toBe(false);
  });
});

describe('按扩展名归类是移动', () => {
  it('docx 和 pdf 各自进文件夹，原位置不再留下', () => {
    writeFileSync(join(ws, '周报.docx'), 'doc');
    writeFileSync(join(ws, '附件.pdf'), 'pdf');
    const result = run({
      operation: 'group',
      workspace: ws,
      files: ['周报.docx', '附件.pdf'],
    });
    expect(result.status).toBe(EXIT.ok);
    expect(existsSync(join(ws, '周报.docx'))).toBe(false);
    expect(readFileSync(join(ws, 'docx', '周报.docx'), 'utf8')).toBe('doc');
    expect(readFileSync(join(ws, 'pdf', '附件.pdf'), 'utf8')).toBe('pdf');
  });
});

describe('docx 转 PDF 保留原件', () => {
  function fakeConverter(): string {
    const script = join(dir, 'soffice');
    writeFileSync(
      script,
      `#!/usr/bin/env python3
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse
args = sys.argv[1:]
for item in ("--headless", "--convert-to", "pdf", "--outdir"):
    if item not in args:
        sys.stderr.write("missing " + item)
        sys.exit(1)
profile = next(arg for arg in args if arg.startswith("-env:UserInstallation="))
root = Path(unquote(urlparse(profile.split("=", 1)[1]).path))
if "DisableMacrosExecution" not in (root / "user" / "registrymodifications.xcu").read_text(encoding="utf-8"):
    sys.exit(1)
outdir = Path(args[args.index("--outdir") + 1])
(outdir / "document.pdf").write_bytes(b"%PDF-1.4\\n")
`,
      'utf8',
    );
    chmodSync(script, 0o755);
    return script;
  }

  it('写出 PDF 头，docx 还在', () => {
    writeFileSync(join(ws, '周报.docx'), 'doc');
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['周报.docx'] },
      { EVOWORK_OFFICE_CONVERTER: fakeConverter() },
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(ws, '周报.docx'), 'utf8')).toBe('doc');
    expect(readFileSync(join(ws, '周报.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('转换失败时 docx 原件还在，也不留下 PDF', () => {
    writeFileSync(join(ws, '周报.docx'), 'doc');
    const script = join(dir, 'soffice-fail');
    writeFileSync(script, '#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n', 'utf8');
    chmodSync(script, 0o755);
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['周报.docx'] },
      { EVOWORK_OFFICE_CONVERTER: script },
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(readFileSync(join(ws, '周报.docx'), 'utf8')).toBe('doc');
    expect(existsSync(join(ws, '周报.pdf'))).toBe(false);
  });

  it('没有 soffice 时不产生 PDF', () => {
    writeFileSync(join(ws, '周报.docx'), 'doc');
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['周报.docx'] },
      { EVOWORK_OFFICE_CONVERTER: '/nonexistent/soffice' },
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('LibreOffice');
    expect(existsSync(join(ws, '周报.pdf'))).toBe(false);
    expect(readFileSync(join(ws, '周报.docx'), 'utf8')).toBe('doc');
  });
});

describe('合并表格不删原件', () => {
  it('csv 按表头拼接', () => {
    writeFileSync(join(ws, '一月.csv'), '摘要,金额\n出租车,128.00\n');
    writeFileSync(join(ws, '二月.csv'), '摘要,金额\n餐饮,56.00\n');
    const result = run({
      operation: 'merge',
      workspace: ws,
      sources: ['一月.csv', '二月.csv'],
      out: '合计.csv',
    });
    expect(result.status).toBe(EXIT.ok);
    expect(readFileSync(join(ws, '合计.csv'), 'utf8')).toContain('餐饮,56.00');
    expect(readFileSync(join(ws, '一月.csv'), 'utf8')).toContain('出租车');
    expect(existsSync(join(ws, '合计.csv.partial'))).toBe(false);
  });

  it('表头不一致时不写出合并结果', () => {
    writeFileSync(join(ws, '一月.csv'), '摘要,金额\n出租车,128.00\n');
    writeFileSync(join(ws, '二月.csv'), '名称,数值\n餐饮,56.00\n');
    const result = run({
      operation: 'merge',
      workspace: ws,
      sources: ['一月.csv', '二月.csv'],
      out: '合计.csv',
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('表头');
    expect(existsSync(join(ws, '合计.csv'))).toBe(false);
    expect(existsSync(join(ws, '合计.csv.partial'))).toBe(false);
  });

  it('xlsx 合成一个工作簿，源文件还在', () => {
    execFileSync('python3', [
      '-c',
      [
        'from openpyxl import Workbook',
        'from pathlib import Path',
        `root = Path(${JSON.stringify(ws)})`,
        'first = Workbook(); sheet = first.active; sheet.title = "收入"; sheet.append(["摘要", "金额"]); sheet.append(["出租车", 128]); first.save(root / "一月.xlsx")',
        'second = Workbook(); sheet = second.active; sheet.title = "支出"; sheet.append(["摘要", "金额"]); sheet.append(["餐饮", 56]); second.save(root / "二月.xlsx")',
      ].join('\n'),
    ]);
    const result = run({
      operation: 'merge',
      workspace: ws,
      sources: ['一月.xlsx', '二月.xlsx'],
      out: '合计.xlsx',
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    const listed = execFileSync(
      'python3',
      [
        '-c',
        `from openpyxl import load_workbook; print(",".join(load_workbook(${JSON.stringify(join(ws, '合计.xlsx'))}).sheetnames))`,
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(listed.split(',').sort()).toEqual(['支出', '收入']);
    expect(existsSync(join(ws, '一月.xlsx'))).toBe(true);
    expect(existsSync(join(ws, '二月.xlsx'))).toBe(true);
  });

  it('没有 openpyxl 时 xlsx 合并是退出码 3，源文件还在', () => {
    writeFileSync(join(ws, '一月.xlsx'), 'not a workbook');
    writeFileSync(join(ws, '二月.xlsx'), 'not a workbook');
    const result = run(
      {
        operation: 'merge',
        workspace: ws,
        sources: ['一月.xlsx', '二月.xlsx'],
        out: '合计.xlsx',
      },
      WITHOUT_OFFICE_RUNTIME,
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('办公扩展');
    expect(existsSync(join(ws, '合计.xlsx'))).toBe(false);
    expect(readFileSync(join(ws, '一月.xlsx'), 'utf8')).toBe('not a workbook');
  });
});
