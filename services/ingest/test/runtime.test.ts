/**
 * 三档运行时（08 §4）。
 *
 * 这个文件里最重要的一条是最后那组：**解析侧与生成侧的文案必须一模一样**。
 * 08 §4 的原话是「提示文案要统一，不能一次说"解析组件"、一次说"生成组件"」——
 * 而这两处一个在 TypeScript 里、一个在 Python 里，靠自觉一定会分叉。
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  availabilityFor,
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
});
