import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXIT,
  ON_PLATFORM_WITHOUT_ISOLATION,
  WITHOUT_OFFICE_RUNTIME,
  makeTempDir,
  parseFailure,
  removeDir,
  writeContent,
  type RunResult,
} from '../../_shared/test-helpers.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(TEST_DIR, '../container_tools/run.py');
/** 在第 N 次 os.link 上制造故障的夹具，见它自己的头注释 */
const FLAKY_LINK = join(TEST_DIR, 'fixtures', 'flaky-link');
const onMac = process.platform === 'darwin';

let dir: string;
let ws: string;
beforeEach(() => {
  dir = makeTempDir('evowork-batch-');
  ws = join(dir, 'ws');
  mkdirSync(ws);
});
afterEach(() => removeDir(dir));

/**
 * 默认在工作区里跑：内核就是在任务目录里执行命令的，workspace 必须是它或它里面的文件夹。
 * `ws` 故意不取真实路径 —— macOS 的临时目录在 /var 下，而 /var 是指向 /private/var 的系统链接。
 */
function run(
  content: unknown,
  options: { env?: Readonly<Record<string, string>>; cwd?: string } = {},
): RunResult {
  const result = spawnSync(
    'python3',
    [RUN, '--content', writeContent(dir, content), '--out', join(dir, 'report.json')],
    { cwd: options.cwd ?? ws, encoding: 'utf8', env: { ...process.env, ...options.env } },
  );
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function report(): { files: { from?: string; to?: string; pdf?: string }[] } {
  return JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as {
    files: { from?: string; to?: string; pdf?: string }[];
  };
}

function flaky(faults: { fail?: number[]; race?: number[] }): Record<string, string> {
  return {
    PYTHONPATH: FLAKY_LINK,
    EVOWORK_TEST_LINK_FAIL: (faults.fail ?? []).join(','),
    EVOWORK_TEST_LINK_RACE: (faults.race ?? []).join(','),
  };
}

/** 失败必须是一行结构化 JSON，不能是裸 traceback */
function failure(result: RunResult) {
  expect(result.stderr).not.toContain('Traceback');
  return parseFailure(result.stderr);
}

function listing(path: string): string[] {
  return readdirSync(path).sort();
}

describe('workspace 是模型写的，只认任务目录', () => {
  it('workspace 经过符号链接指到任务目录时照常工作（macOS 的 /var 就是这种链接）', () => {
    const alias = join(dir, 'alias');
    symlinkSync(ws, alias);
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: alias,
      items: [{ from: join(alias, 'a.txt'), to: 'b.txt' }],
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('a');
    expect(report().files).toEqual([{ from: 'a.txt', to: 'b.txt' }]);
  });

  it('workspace 是 / 时拒绝，哪怕条目都在任务目录里', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: '/',
      items: [{ from: join(ws, 'a.txt'), to: join(ws, 'b.txt') }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(failure(result).message).toContain('任务目录');
    expect(listing(ws)).toEqual(['a.txt']);
  });

  it('workspace 是任务目录的上一层时拒绝', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: dir,
      items: [{ from: 'ws/a.txt', to: 'ws/b.txt' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(failure(result).message).toContain('任务目录');
    expect(listing(ws)).toEqual(['a.txt']);
  });

  it('workspace 是任务目录外的另一个真实文件夹时拒绝，那里的文件不动', () => {
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: other,
      items: [{ from: 'a.txt', to: 'b.txt' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(failure(result).message).toContain('任务目录');
    expect(listing(other)).toEqual(['a.txt']);
  });

  it('workspace 写成 ~ 时拒绝（不展开家目录）', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: '~',
      items: [{ from: join(ws, 'a.txt'), to: join(ws, 'b.txt') }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(failure(result).message).toContain('绝对路径');
    expect(listing(ws)).toEqual(['a.txt']);
  });

  it('任务目录里的子文件夹可以当 workspace', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run(
      { operation: 'rename', workspace: ws, items: [{ from: 'a.txt', to: 'b.txt' }] },
      { cwd: dir },
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(listing(ws)).toEqual(['b.txt']);
  });
});

describe('只在工作区里移动', () => {
  it('重命名会挪走原文件', () => {
    writeFileSync(join(ws, '草稿.txt'), '周报');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [{ from: '草稿.txt', to: '周报.txt' }],
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
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
    expect(failure(result).message).toContain('50');
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
    expect(failure(result).message).toContain('符号链接');
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
    expect(failure(result).message).toContain('符号链接');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(lstatSync(join(ws, 'secret.txt')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(ws, 'copied.txt'))).toBe(false);
  });
});

describe('不分大小写的盘上也不覆盖（macOS 默认就是这种盘）', () => {
  it.each([
    ['大小写', 'X.txt', 'x.txt'],
    ['Unicode 写法', 'café.txt', 'café.txt'],
  ])('两个重命名目标只差%s时一个都不改', (_kind, first, second) => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    writeFileSync(join(ws, 'b.txt'), 'b');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [
        { from: 'a.txt', to: first },
        { from: 'b.txt', to: second },
      ],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    failure(result);
    expect(listing(ws)).toEqual(['a.txt', 'b.txt']);
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('b');
  });

  it('目标与已有文件只差大小写时拒绝', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    writeFileSync(join(ws, 'Report.txt'), 'old');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [{ from: 'a.txt', to: 'report.txt' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    failure(result);
    expect(listing(ws)).toEqual(['Report.txt', 'a.txt']);
    expect(readFileSync(join(ws, 'Report.txt'), 'utf8')).toBe('old');
  });

  it('只改大小写的重命名照常完成，内容不丢', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run({
      operation: 'rename',
      workspace: ws,
      items: [{ from: 'a.txt', to: 'A.txt' }],
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(listing(ws)).toEqual(['A.txt']);
    expect(readFileSync(join(ws, 'A.txt'), 'utf8')).toBe('a');
  });

  it('归类时 Note.TXT 和 note.txt 不会挤进同一个名字', () => {
    mkdirSync(join(ws, '一'));
    mkdirSync(join(ws, '二'));
    writeFileSync(join(ws, '一', 'Note.TXT'), 'upper');
    writeFileSync(join(ws, '二', 'note.txt'), 'lower');
    const result = run({
      operation: 'group',
      workspace: ws,
      files: ['一/Note.TXT', '二/note.txt'],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    failure(result);
    expect(readFileSync(join(ws, '一', 'Note.TXT'), 'utf8')).toBe('upper');
    expect(readFileSync(join(ws, '二', 'note.txt'), 'utf8')).toBe('lower');
    expect(existsSync(join(ws, 'txt'))).toBe(false);
  });

  it('归类沿用已有的 PDF/ 文件夹，不在旁边再建一个 pdf/，报告写的是文件真实的位置', () => {
    mkdirSync(join(ws, 'PDF'));
    writeFileSync(join(ws, '附件.pdf'), 'pdf');
    const result = run({ operation: 'group', workspace: ws, files: ['附件.pdf'] });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(listing(ws)).toEqual(['PDF']);
    expect(readFileSync(join(ws, 'PDF', '附件.pdf'), 'utf8')).toBe('pdf');
    expect(report().files).toEqual([{ from: '附件.pdf', to: 'PDF/附件.pdf' }]);
  });

  it('检查之后目标被别的程序抢先占了，也不覆盖它', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    const result = run(
      { operation: 'rename', workspace: ws, items: [{ from: 'a.txt', to: 'b.txt' }] },
      { env: flaky({ race: [1] }) },
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(failure(result).message).toContain('占');
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('intruder');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a');
  });
});

describe('要么全做，要么不做', () => {
  it.each([
    [
      [
        { from: 'a.txt', to: 'x/y.txt' },
        { from: 'b.txt', to: 'x' },
      ],
    ],
    [
      [
        { from: 'a.txt', to: 'x' },
        { from: 'b.txt', to: 'x/y.txt' },
      ],
    ],
  ])('一个目标要当另一个目标的文件夹时，动手之前就拒绝 %#', (items) => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    writeFileSync(join(ws, 'b.txt'), 'b');
    const result = run({ operation: 'rename', workspace: ws, items });
    expect(result.status).toBe(EXIT.invalidContent);
    failure(result);
    expect(listing(ws)).toEqual(['a.txt', 'b.txt']);
  });

  it('执行到一半出错时撤回已经做的步骤，工作区和执行前一样', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    writeFileSync(join(ws, 'b.txt'), 'b');
    const result = run(
      {
        operation: 'rename',
        workspace: ws,
        items: [
          { from: 'a.txt', to: 'x/a.txt' },
          { from: 'b.txt', to: 'y.txt' },
        ],
      },
      { env: flaky({ fail: [2] }) },
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(failure(result).message).toContain('撤回');
    expect(listing(ws)).toEqual(['a.txt', 'b.txt']);
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a');
    expect(existsSync(join(dir, 'report.json'))).toBe(false);
  });

  it('撤回也失败时退出码 6，逐条列出真正生效的改动，与磁盘上一致', () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    writeFileSync(join(ws, 'b.txt'), 'b');
    const result = run(
      {
        operation: 'rename',
        workspace: ws,
        items: [
          { from: 'a.txt', to: 'x/a.txt' },
          { from: 'b.txt', to: 'y.txt' },
        ],
      },
      { env: flaky({ fail: [2, 3] }) },
    );
    expect(result.status).toBe(EXIT.partial);
    const message = failure(result).message;
    expect(message).toContain('a.txt → x/a.txt');
    expect(message).toContain('新建了文件夹 x/');
    // b 没动过，不能报成动过
    expect(message).not.toContain('b.txt →');
    expect(listing(ws)).toEqual(['b.txt', 'x']);
    expect(readFileSync(join(ws, 'x', 'a.txt'), 'utf8')).toBe('a');
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
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(existsSync(join(ws, '周报.docx'))).toBe(false);
    expect(readFileSync(join(ws, 'docx', '周报.docx'), 'utf8')).toBe('doc');
    expect(readFileSync(join(ws, 'pdf', '附件.pdf'), 'utf8')).toBe('pdf');
  });
});

describe('docx 转 PDF 保留原件', () => {
  /**
   * 假转换器写成 /bin/sh 脚本：转换在 seatbelt 沙箱里跑，只读得到系统目录与转换器自己所在的目录。
   * 内容里有 broken 的 docx 转不成，其余写出一个带 %PDF 头的文件。
   */
  function fakeConverter(): string {
    const script = join(dir, 'soffice');
    writeFileSync(
      script,
      `#!/bin/sh
prev=""; outdir=""; last=""
for arg in "$@"; do [ "$prev" = "--outdir" ] && outdir="$arg"; prev="$arg"; last="$arg"; done
case "$(/bin/cat "$last")" in *broken*) echo "cannot convert" >&2; exit 1;; esac
printf '%%PDF-1.4\\n%%fake\\n' > "$outdir/document.pdf"
`,
      'utf8',
    );
    chmodSync(script, 0o755);
    return script;
  }

  it.runIf(onMac)('写出 PDF 头，docx 还在', () => {
    writeFileSync(join(ws, '周报.docx'), 'doc');
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['周报.docx'] },
      { env: { EVOWORK_OFFICE_CONVERTER: fakeConverter() } },
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(ws, '周报.docx'), 'utf8')).toBe('doc');
    expect(readFileSync(join(ws, '周报.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(listing(ws)).toEqual(['周报.docx', '周报.pdf']);
  });

  it.runIf(onMac)('转换失败是退出码 5（不是「缺运行时」），docx 原件还在，也不留下 PDF', () => {
    writeFileSync(join(ws, '周报.docx'), 'broken');
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['周报.docx'] },
      { env: { EVOWORK_OFFICE_CONVERTER: fakeConverter() } },
    );
    expect(result.status).toBe(EXIT.conversionFailed);
    failure(result);
    expect(listing(ws)).toEqual(['周报.docx']);
    expect(readFileSync(join(ws, '周报.docx'), 'utf8')).toBe('broken');
  });

  it.runIf(onMac)('第二份转不成时，第一份的 PDF 也不留下', () => {
    writeFileSync(join(ws, 'a.docx'), 'ok');
    writeFileSync(join(ws, 'b.docx'), 'broken');
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['a.docx', 'b.docx'] },
      { env: { EVOWORK_OFFICE_CONVERTER: fakeConverter() } },
    );
    expect(result.status).toBe(EXIT.conversionFailed);
    expect(listing(ws)).toEqual(['a.docx', 'b.docx']);
  });

  it.runIf(onMac)('PDF 写进工作区时中途出错，已经写出的 PDF 撤回，也不留临时文件', () => {
    writeFileSync(join(ws, 'a.docx'), 'ok');
    writeFileSync(join(ws, 'b.docx'), 'ok');
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['a.docx', 'b.docx'] },
      { env: { EVOWORK_OFFICE_CONVERTER: fakeConverter(), ...flaky({ fail: [2] }) } },
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(failure(result).message).toContain('撤回');
    expect(listing(ws)).toEqual(['a.docx', 'b.docx']);
  });

  it.each(onMac ? ['./周报.docx', '周报.DOCX'] : ['./周报.docx'])(
    '同一份 docx 列两次（第二次写成 %s）时拒绝，不让后一份 PDF 盖掉前一份',
    (again) => {
      writeFileSync(join(ws, '周报.docx'), 'doc');
      const result = run(
        { operation: 'docx-to-pdf', workspace: ws, files: ['周报.docx', again] },
        { env: { EVOWORK_OFFICE_CONVERTER: fakeConverter() } },
      );
      expect(result.status).toBe(EXIT.invalidContent);
      expect(failure(result).message).toContain('两次');
      expect(listing(ws)).toEqual(['周报.docx']);
    },
  );

  it('没有 soffice 时退出码 3，不产生 PDF', () => {
    writeFileSync(join(ws, '周报.docx'), 'doc');
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['周报.docx'] },
      { env: { EVOWORK_OFFICE_CONVERTER: '/nonexistent/soffice' } },
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(failure(result).message).toContain('LibreOffice');
    expect(listing(ws)).toEqual(['周报.docx']);
  });

  it('还没有隔离手段的平台上拒绝转换（退出码 3），不落盘', () => {
    writeFileSync(join(ws, '周报.docx'), 'doc');
    const result = run(
      { operation: 'docx-to-pdf', workspace: ws, files: ['周报.docx'] },
      { env: { ...ON_PLATFORM_WITHOUT_ISOLATION, EVOWORK_OFFICE_CONVERTER: fakeConverter() } },
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(failure(result).message).toContain('隔离');
    expect(listing(ws)).toEqual(['周报.docx']);
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
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(ws, '合计.csv'), 'utf8')).toContain('餐饮,56.00');
    expect(readFileSync(join(ws, '一月.csv'), 'utf8')).toContain('出租车');
    expect(listing(ws)).toEqual(['一月.csv', '二月.csv', '合计.csv']);
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
    expect(failure(result).message).toContain('表头');
    expect(listing(ws)).toEqual(['一月.csv', '二月.csv']);
  });

  it('预先在旁边放好的符号链接引不走合并结果，工作区外一个字节都不写', () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(ws, '一月.csv'), '摘要,金额\n出租车,128.00\n');
    writeFileSync(join(ws, '二月.csv'), '摘要,金额\n餐饮,56.00\n');
    // 旧实现固定写 `<out>.partial`，并跟随那里的（悬空）链接
    symlinkSync(join(outside, 'leak.csv'), join(ws, '合计.csv.partial'));
    const result = run({
      operation: 'merge',
      workspace: ws,
      sources: ['一月.csv', '二月.csv'],
      out: '合计.csv',
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(listing(outside)).toEqual([]);
    expect(lstatSync(join(ws, '合计.csv.partial')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(ws, '合计.csv'), 'utf8')).toContain('餐饮,56.00');
  });

  it('写合并结果时目标被别的程序抢先占了，不覆盖它，也不留临时文件', () => {
    writeFileSync(join(ws, '一月.csv'), '摘要,金额\n出租车,128.00\n');
    writeFileSync(join(ws, '二月.csv'), '摘要,金额\n餐饮,56.00\n');
    const result = run(
      { operation: 'merge', workspace: ws, sources: ['一月.csv', '二月.csv'], out: '合计.csv' },
      { env: flaky({ race: [1] }) },
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(failure(result).message).toContain('占');
    expect(readFileSync(join(ws, '合计.csv'), 'utf8')).toBe('intruder');
    expect(listing(ws)).toEqual(['一月.csv', '二月.csv', '合计.csv']);
  });

  it('合并结果写进还不存在的文件夹时先建好它', () => {
    writeFileSync(join(ws, '一月.csv'), '摘要,金额\n出租车,128.00\n');
    writeFileSync(join(ws, '二月.csv'), '摘要,金额\n餐饮,56.00\n');
    const result = run({
      operation: 'merge',
      workspace: ws,
      sources: ['一月.csv', '二月.csv'],
      out: '汇总/合计.csv',
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(ws, '汇总', '合计.csv'), 'utf8')).toContain('出租车,128.00');
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
      { env: WITHOUT_OFFICE_RUNTIME },
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(failure(result).message).toContain('办公扩展');
    expect(existsSync(join(ws, '合计.xlsx'))).toBe(false);
    expect(readFileSync(join(ws, '一月.xlsx'), 'utf8')).toBe('not a workbook');
  });
});
