/**
 * 四个技能的测试共用的跑法。
 *
 * 抽出来的理由与 `evowork_skill.py` 一样：四份一模一样的 `spawnSync` 包装
 * 会慢慢分叉（典型是有的传了 `encoding` 有的没传，于是断言写法不同）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_DIR = dirname(fileURLToPath(import.meta.url));

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runPython(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): RunResult {
  const result = spawnSync('python3', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * 某个 python 模块在不在（08 §4 的档位判定）。用来决定跳过哪些测试。
 *
 * **必须与技能自己的解析方式一致**：`evowork_skill.ensure_office_runtime` 会在缺模块时
 * 换到办公扩展的解释器重跑，所以"系统 python3 里没有 matplotlib"**不等于**"没装办公扩展"。
 *
 * 这条是被测试抓出来的：装上办公扩展之后，`skipIf` 仍按系统 python 判定，
 * 于是"没装扩展时应该退出码 3"那几条跑了起来，而技能其实成功了。
 * 两边用同一个判据，这种偏差就不会再出现。
 */
export function hasPythonModule(name: string): boolean {
  const script = [
    'import sys, importlib.util',
    `sys.path.insert(0, ${JSON.stringify(join(SHARED_DIR, ''))})`,
    'import evowork_skill as e',
    `ok = importlib.util.find_spec(${JSON.stringify(name)}) is not None`,
    'if not ok:',
    '    p = e.office_python()',
    '    ok = p is not None',
    'sys.exit(0 if ok else 1)',
  ].join('\n');
  return spawnSync('python3', ['-c', script], { encoding: 'utf8' }).status === 0;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 写一份内容 JSON，返回它的路径。 */
export function writeContent(dir: string, content: unknown, name = 'content.json'): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(content), 'utf8');
  return path;
}

/** 解析失败输出（技能的 stderr 是一行 JSON，见 `evowork_skill.fail`）。 */
export function parseFailure(stderr: string): {
  ok: false;
  code: number;
  message: string;
  detail?: string;
} {
  return JSON.parse(stderr) as { ok: false; code: number; message: string; detail?: string };
}

/**
 * 强制"没装办公扩展"的环境。
 *
 * **两个变量缺一不可**，因为"没装办公扩展"其实是两件事：
 *
 *   · `EVOWORK_OFFICE_PYTHON` 指向不存在的解释器 → `office_python()` 返回 None
 *     → 不 re-exec → 走缺模块那条路；
 *   · `PYTHONPATH` 指向 `test-fixtures/no-office/`，那里的 `sitecustomize.py`
 *     在解释器启动时把**办公扩展的那几个模块**挡掉。
 *
 * 第二条是 2026-09-06 补的，补之前这个 fixture **名不副实**：`ensure_office_runtime`
 * 先看"当前解释器里缺不缺模块"，不缺就直接返回 —— 而开发机的
 * `~/Library/Python/3.x/lib/python/site-packages` 里往往早就有 python-docx / openpyxl
 * （被别的项目装进去的）。于是这条测试在那些机器上**渲染成功、退出码 0**，
 * 断言 3 号码失败。它本来是为了"不靠 skipIf、强制构造那个环境"而写的
 * （CLAUDE.md §9.1），却因为漏掉一半而变回了"看本机脸色"。
 *
 * （试过 `PYTHONNOUSERSITE=1`，**不行**：它一刀切掉整个用户级 site-packages，
 * 连 `jsonschema` 一起挡掉，于是走进"校验库缺失"分支 —— 退出码同样是 3、文案完全不同。
 * 挡的范围必须精确到模块名，理由见那个 `sitecustomize.py` 的头注释。）
 *
 * 这样**两条分支都能被测，不管本机装没装扩展**。只用 `skipIf` 的话，
 * 装了扩展的机器上"没装时该怎么办"就永远没人验 —— 而那条路径恰恰是用户第一次用时走的。
 */
export const WITHOUT_OFFICE_RUNTIME = Object.freeze({
  EVOWORK_OFFICE_PYTHON: '/nonexistent/evowork-office/bin/python',
  PYTHONPATH: join(SHARED_DIR, 'test-fixtures', 'no-office'),
});

export const EXIT = {
  ok: 0,
  invalidContent: 2,
  runtimeMissing: 3,
  missingAsset: 4,
} as const;
