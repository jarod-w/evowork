/**
 * 三档解析运行时的分发（08 §4，R10 的落点）。
 *
 * ## 为什么不全量随包
 *
 * 全量携带 Python + 办公库 + tesseract 中文模型是 300MB+，把它挡在"第一次打开应用"前面
 * 会让大量用户在还没看到产品之前就流失。所以按档分发，用到哪档下哪档。
 *
 * ## 一条容易被忽略的约束：**文案必须统一**
 *
 * 08 §4 的原话：「产物生成技能同样依赖办公扩展，因此首次生成 PPT/Word 也会触发同一次下载。
 * 提示文案要统一，不能一次说"解析组件"、一次说"生成组件"」。
 *
 * 落法是：这里与 `plugins/skills/_shared/evowork_skill.py` 的 `RUNTIME_TIERS` 是同一份数据，
 * 由 `test/runtime.test.ts` 逐字段比对 —— 两边分叉会直接变红。
 * 不共用一个文件是因为一边是 TS 一边是 Python，而这条约束值得用测试而不是靠自觉来守。
 */

export type RuntimeTier = 'base' | 'office' | 'ocr';

export interface TierSpec {
  readonly label: string;
  /** 用户看到的体积说明 */
  readonly size: string;
  readonly note: string;
  /** 判定这一档是否可用的探针（python 模块名；base 档为空） */
  readonly probeModules: readonly string[];
}

export const RUNTIME_TIERS: Readonly<Record<RuntimeTier, TierSpec>> = Object.freeze({
  base: {
    label: '基础组件',
    size: '0MB',
    note: '随主程序，无需下载',
    probeModules: [],
  },
  office: {
    label: '办公扩展',
    size: '约 120MB',
    note: 'Word / Excel / PPT / PDF 文本层',
    probeModules: ['docx', 'openpyxl', 'pptx', 'pdfplumber', 'matplotlib'],
  },
  ocr: {
    label: 'OCR 扩展',
    size: '约 60MB',
    note: '扫描件识别',
    probeModules: ['pytesseract'],
  },
});

/**
 * 统一文案（08 §4）。**生成与解析共用这一句** ——
 * 一处说"解析组件"、一处说"生成组件"会让用户以为要装两个东西。
 */
export function runtimeMissingMessage(tier: RuntimeTier, what: string): string {
  const spec = RUNTIME_TIERS[tier];
  return `需要安装本地${spec.label}（${spec.size}）才能${what}。安装后重试即可。`;
}

/** 可解析的输入类型。`code` 与 `image` 不进解析器（08 §3.3 的最后两行）。 */
export type InputKind =
  | 'txt'
  | 'md'
  | 'csv'
  | 'tsv'
  | 'json'
  | 'zip'
  | 'pdf'
  | 'pdf-scanned'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'rtf'
  | 'image'
  | 'code'
  | 'unknown';

/**
 * 每种输入需要哪一档运行时。
 *
 * `image` 与 `code` 是 `base` 而不是"不需要"：它们**走的是不解析这条路**
 * （直接 `LocalImage` / `Mention`），而那条路本来就不需要任何扩展。
 */
export const TIER_OF: Readonly<Record<InputKind, RuntimeTier>> = Object.freeze({
  txt: 'base',
  md: 'base',
  csv: 'base',
  tsv: 'base',
  json: 'base',
  zip: 'base',
  image: 'base',
  code: 'base',
  unknown: 'base',
  pdf: 'office',
  docx: 'office',
  xlsx: 'office',
  pptx: 'office',
  rtf: 'office',
  'pdf-scanned': 'ocr',
});

/**
 * 办公扩展装在**它自己的目录**里（`~/.evowork/runtime/office`），不污染系统 python。
 *
 * 这样三件事同时成立：卸载扩展 = 删一个目录；系统 python 升级不会带走它；
 * 而"装没装"这个判断就是"那个目录里的解释器能不能 import 那些模块"，没有歧义。
 * 企业离线部署把它装在别处时用 `EVOWORK_OFFICE_PYTHON` 覆盖。
 *
 * 与 `plugins/skills/_shared/evowork_skill.py` 的 `office_python()` 是同一套路径约定，
 * 由 `test/runtime.test.ts` 比对 —— 两边分叉的表现是"解析说装了、生成说没装"。
 */
export const OFFICE_RUNTIME_DIR = '.evowork/runtime/office';

export function officeInterpreterPaths(home: string): readonly string[] {
  return [
    `${home}/${OFFICE_RUNTIME_DIR}/bin/python`,
    `${home}/${OFFICE_RUNTIME_DIR}/Scripts/python.exe`,
  ];
}

export interface RuntimeProbe {
  /** 某个 python 模块在不在。注入以便测试 */
  hasModule(name: string): boolean;
}

export interface TierStatus {
  readonly tier: RuntimeTier;
  readonly installed: boolean;
  /** 缺哪些模块。**逐个列出来**，因为"装了一半"是真实会发生的状态 */
  readonly missing: readonly string[];
}

export function probeTiers(probe: RuntimeProbe): readonly TierStatus[] {
  return (Object.keys(RUNTIME_TIERS) as RuntimeTier[]).map((tier) => {
    const missing = RUNTIME_TIERS[tier].probeModules.filter((m) => !probe.hasModule(m));
    return { tier, installed: missing.length === 0, missing };
  });
}

/**
 * 这种输入现在能不能处理。
 *
 * 返回的不是布尔而是"缺什么 + 该说什么"，因为 03 §8 要求的是
 * 「需要安装本地解析组件（约 180MB）」+ 「安装」/「以原始文件引用」两个出路，
 * 而不是一句"不支持"。
 */
export interface Availability {
  readonly available: boolean;
  readonly tier: RuntimeTier;
  readonly message?: string;
}

export function availabilityFor(kind: InputKind, probe: RuntimeProbe): Availability {
  const tier = TIER_OF[kind];
  if (tier === 'base') return { available: true, tier };
  const missing = RUNTIME_TIERS[tier].probeModules.filter((m) => !probe.hasModule(m));
  if (missing.length === 0) return { available: true, tier };
  return {
    available: false,
    tier,
    message: runtimeMissingMessage(tier, kind === 'pdf-scanned' ? '识别扫描件' : '解析这个文件'),
  };
}
