/**
 * 三档运行时（08 §4）。
 *
 * 这个文件里最重要的一条是最后那组：**解析侧与生成侧的文案必须一模一样**。
 * 08 §4 的原话是「提示文案要统一，不能一次说"解析组件"、一次说"生成组件"」——
 * 而这两处一个在 TypeScript 里、一个在 Python 里，靠自觉一定会分叉。
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  availabilityFor,
  officeFontsPath,
  officeInterpreterPaths,
  probeTiers,
  RUNTIME_TIERS,
  runtimeMissingMessage,
  TIER_OF,
  type RuntimeTier,
} from '../src/runtime.js';

const SHARED_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/skills/_shared',
);

describe('档位与输入类型的对应', () => {
  it('基础包覆盖纯文本与数据文件 —— 什么都没装也能干活', () => {
    for (const kind of ['txt', 'md', 'csv', 'tsv', 'json', 'zip'] as const) {
      expect(TIER_OF[kind], kind).toBe('base');
    }
  });

  it('Office 四种走办公扩展，扫描件走 OCR 扩展', () => {
    for (const kind of ['pdf', 'docx', 'xlsx', 'pptx'] as const) {
      expect(TIER_OF[kind], kind).toBe('office');
    }
    expect(TIER_OF['pdf-scanned']).toBe('ocr');
  });

  it('图片与代码是 base —— 它们走的是**不解析**那条路', () => {
    expect(TIER_OF.image).toBe('base');
    expect(TIER_OF.code).toBe('base');
  });
});

describe('探测：装了一半是真实会发生的状态', () => {
  it('逐个列出缺哪些模块，而不是只说"没装"', () => {
    const probe = { hasModule: (name: string) => name !== 'pptx' };
    const office = probeTiers(probe).find((t) => t.tier === 'office');
    expect(office?.installed).toBe(false);
    expect(office?.missing).toEqual(['pptx']);
  });

  it('base 档永远可用（它没有可探测的模块）', () => {
    const base = probeTiers({ hasModule: () => false }).find((t) => t.tier === 'base');
    expect(base?.installed).toBe(true);
  });

  it('availabilityFor 给的是"缺什么 + 该说什么"，不是一个布尔', () => {
    const result = availabilityFor('docx', { hasModule: () => false });
    expect(result.available).toBe(false);
    expect(result.tier).toBe('office');
    expect(result.message).toContain('办公扩展');
    expect(result.message).toContain('约 120MB');
  });

  it('扫描件的文案说的是"识别扫描件"而不是泛泛的"解析这个文件"', () => {
    expect(availabilityFor('pdf-scanned', { hasModule: () => false }).message).toContain(
      '识别扫描件',
    );
  });
});

describe('**解析侧与生成侧的文案必须一致**（08 §4）', () => {
  /** 从 Python 侧把同一张表读出来 —— 两边分叉时这条会红。 */
  function pythonTiers(): Record<string, { label: string; size: string; note: string }> {
    const script = [
      'import json,sys',
      `sys.path.insert(0, ${JSON.stringify(SHARED_PY)})`,
      'import evowork_skill as e',
      'print(json.dumps(e.RUNTIME_TIERS, ensure_ascii=False))',
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' })) as Record<
      string,
      { label: string; size: string; note: string }
    >;
  }

  it('三档的 label / size / note 逐字相同', () => {
    const python = pythonTiers();
    expect(Object.keys(python).sort()).toEqual(Object.keys(RUNTIME_TIERS).sort());
    for (const tier of Object.keys(RUNTIME_TIERS) as RuntimeTier[]) {
      const ts = RUNTIME_TIERS[tier];
      expect(python[tier], tier).toEqual({ label: ts.label, size: ts.size, note: ts.note });
    }
  });

  it('缺失提示这句话两边一模一样 —— 用户不该看到两种说法', () => {
    const script = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(SHARED_PY)})`,
      'import evowork_skill as e',
      'print(e.runtime_missing_message("office", "生成 pptx"))',
    ].join('\n');
    const fromPython = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();
    expect(fromPython).toBe(runtimeMissingMessage('office', '生成 pptx'));
  });

  /**
   * **解释器候选路径两边必须一样**。
   *
   * 分叉的表现最难查：探针在 `bin/python` 找不到就说"没装"，而技能从
   * `bin/python3` 找到了照常跑 —— 界面说没装、产物却生成得好好的（或者反过来）。
   * 2026-09-07 加了 python-build-standalone 的两个候选（`bin/python3` 与根上的
   * `python.exe`）之后，两边各有一份四元组，这条断言是它们唯一的粘合剂。
   */
  it('解释器候选路径与 Python 侧逐条相同（顺序也要一样）', () => {
    const script = [
      'import json,sys',
      `sys.path.insert(0, ${JSON.stringify(SHARED_PY)})`,
      'import evowork_skill as e',
      /*
       * 把 `office_python()` **真正在用的那张表**读走，不在这里抄一份。
       * 抄一份的话，有人改了 Python 侧的候选顺序，这条测试照样通过 —— 也就什么都没守住。
       */
      'print(json.dumps([str(p) for p in e.office_interpreter_candidates()]))',
    ].join('\n');
    const fromPython = JSON.parse(
      execFileSync('python3', ['-c', script], { encoding: 'utf8' }),
    ) as string[];

    expect(fromPython).toEqual([...officeInterpreterPaths(homedir())]);
  });

  /** 字体目录同理：charts 去那里找中文字体，安装器往那里装。 */
  it('字体目录与 Python 侧一致', () => {
    const script = [
      `import sys; sys.path.insert(0, ${JSON.stringify(SHARED_PY)})`,
      'import evowork_skill as e',
      'print(str(e.OFFICE_VENV / "fonts"))',
    ].join('\n');
    const fromPython = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();
    expect(fromPython).toBe(officeFontsPath(homedir()));
  });
});
