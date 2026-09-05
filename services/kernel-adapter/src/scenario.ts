/**
 * 场景 + 模式 + 用户覆盖 → `turn/start` 参数（03 §2.4）。
 *
 * ## 为什么这段展开必须在适配层
 *
 * 内核有 `CollaborationModeMask` 与 `collaborationMode/list`，看起来正好能装场景。
 * **但 `list_collaboration_modes()` 返回硬编码的 builtins（仅 plan + default），不读任何配置**
 * （F3，`models-manager/src/collaboration_mode_presets.rs:16`）。所以场景目录由 EvoWork 持有，
 * 每次 `turn/start` 由这里展开成完整参数下发 —— 零内核改动、零补丁，
 * 是 CLAUDE.md §4「能放外面就不放里面」的正例。
 *
 * 优先级（03 §2.4）：**场景默认值 → 工作模式 → 用户在 Composer 里的显式选择**。
 */
import type { CollaborationMode, ModeKind, TurnStartParams, UserInput } from '@evowork/protocol';

/** 三个工作模式（D8：固定三项，不新增内核枚举值）。 */
export type ModeId = 'craft' | 'plan' | 'ask';

export interface ModeDefinition {
  readonly id: ModeId;
  /** 面向用户的名字（03 §4.5 的模式选择器） */
  readonly label: string;
  /** F2：`ModeKind` 只有 plan | default —— craft 与 ask 都映射到 default */
  readonly kernelMode: ModeKind;
  /** 权限 profile id（10 §2.2 的四个命名 profile） */
  readonly permissions: string;
  /** developer instructions 片段所在文件（config/modes/*.md），**不进内核仓库**（取代 P3 补丁） */
  readonly instructionsFile: string;
  /** Ask 模式固定只读：权限选择器要自动切到只读并置为禁用（03 §4.5） */
  readonly lockPermissions: boolean;
}

export const MODES: Readonly<Record<ModeId, ModeDefinition>> = Object.freeze({
  craft: {
    id: 'craft',
    label: 'Craft 你说我做',
    kernelMode: 'default',
    permissions: 'evowork-workspace',
    instructionsFile: 'modes/craft.md',
    lockPermissions: false,
  },
  plan: {
    id: 'plan',
    label: 'Plan 先想后做',
    kernelMode: 'plan',
    permissions: 'evowork-plan',
    instructionsFile: 'modes/plan.md',
    lockPermissions: false,
  },
  ask: {
    id: 'ask',
    label: 'Ask 只谈不做',
    kernelMode: 'default',
    permissions: 'evowork-ask',
    instructionsFile: 'modes/ask.md',
    lockPermissions: true,
  },
});

export interface ScenarioChip {
  readonly label: string;
  readonly icon?: string;
  readonly prompt: string;
  readonly requiresFile?: boolean;
}

/** `config/scenarios/*.toml` 的形状（03 §2.2）。 */
export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly order?: number;
  readonly default?: boolean;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly permissions?: string;
  readonly mode?: ModeId;
  readonly instructionsFile?: string;
  readonly skills?: readonly string[];
  readonly connectors?: readonly string[];
  readonly expertsRecommended?: readonly string[];
  readonly chips?: readonly ScenarioChip[];
  readonly budgetLimit?: number;
}

/** 用户在 Composer 里的显式选择（优先级最高）。 */
export interface ComposerOverrides {
  readonly model?: string;
  readonly permissions?: string;
  readonly modeId?: ModeId;
  readonly cwd?: string;
  readonly reasoningEffort?: string;
  readonly budgetLimit?: number;
}

export interface ExpandContext {
  readonly threadId: string;
  readonly input: readonly UserInput[];
  readonly scenario: Scenario;
  readonly overrides?: ComposerOverrides;
  /** 读取 `config/modes/*.md` 与场景片段。缺失时返回 undefined —— 见下面的降级 */
  readonly readInstructions: (file: string) => string | undefined;
  /** 运行时上下文，附在 developer_instructions 末尾（03 §2.4） */
  readonly runtime?: {
    readonly today?: string;
    readonly workspacePath?: string;
    readonly availableSkills?: readonly string[];
  };
  /** `turn/start.collaborationMode` 是否可用（09 §3.3 的降级） */
  readonly collaborationModeAvailable?: boolean;
  /** `turn/start.permissions` 是否可用（同上；与 sandboxPolicy 互斥，F5） */
  readonly permissionsFieldAvailable?: boolean;
}

export interface ExpandResult {
  readonly params: TurnStartParams;
  /** 展开时发生的降级，UI 必须显示（09 §3.3：降级一律显式） */
  readonly degradations: readonly string[];
  /** 落投影表用（09 §4.1 的 EvoWork 字段） */
  readonly origin: {
    readonly scenarioId: string;
    readonly modeId: ModeId;
    readonly permissionId: string;
    readonly budgetLimit?: number;
  };
}

/**
 * 拼接 developer instructions。
 *
 * **顺序固定为「模式片段在前、场景片段在后」**（03 §2.4 原话：场景更具体，后写的优先），
 * 末尾附运行时上下文。顺序写死在这里而不是靠调用方传对，是因为它反了不会报错、
 * 只会让模型的行为微妙地不对 —— 那种 bug 要几周才会被发现。
 */
export function composeInstructions(ctx: ExpandContext, mode: ModeDefinition): string | undefined {
  const parts: string[] = [];
  const modeFragment = ctx.readInstructions(mode.instructionsFile);
  if (modeFragment) parts.push(modeFragment.trim());

  if (ctx.scenario.instructionsFile) {
    const scenarioFragment = ctx.readInstructions(ctx.scenario.instructionsFile);
    if (scenarioFragment) parts.push(scenarioFragment.trim());
  }

  const runtime = ctx.runtime;
  if (runtime) {
    const lines: string[] = [];
    if (runtime.today) lines.push(`今天是 ${runtime.today}。`);
    if (runtime.workspacePath) lines.push(`当前工作空间：${runtime.workspacePath}`);
    if (runtime.availableSkills?.length) {
      lines.push(`可用技能：${runtime.availableSkills.join('、')}`);
    }
    if (lines.length > 0) parts.push(lines.join('\n'));
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * 展开为 `turn/start` 参数。
 *
 * 两处降级（都必须显式上报，09 §3.3）：
 *
 * · `collaborationMode` 不可用 → 退回 `model` + `effort`，**并且必须依赖 ToolContributor
 *   过滤写工具**（D8）。这条 `mustAlsoDo` 不是提醒而是硬要求：只靠沙箱的 Ask 模式会让
 *   模型反复尝试写再失败，那是设计明确要避免的体验。
 * · `permissions` 不可用 → 退回 `sandboxPolicy`（两者互斥，F5），企业自定义档位失效。
 */
export function expandTurnStart(ctx: ExpandContext): ExpandResult {
  const overrides = ctx.overrides ?? {};
  const modeId = overrides.modeId ?? ctx.scenario.mode ?? 'craft';
  const mode = MODES[modeId];
  const degradations: string[] = [];

  // Ask 模式固定只读：用户的权限选择在这里被忽略（03 §4.5 的模式联动）
  const permissionId = mode.lockPermissions
    ? mode.permissions
    : (overrides.permissions ?? ctx.scenario.permissions ?? mode.permissions);

  const model = overrides.model ?? ctx.scenario.model;
  const effort = overrides.reasoningEffort ?? ctx.scenario.reasoningEffort;
  const instructions = composeInstructions(ctx, mode);

  const collaborationModeAvailable = ctx.collaborationModeAvailable ?? true;
  const permissionsFieldAvailable = ctx.permissionsFieldAvailable ?? true;

  let collaborationMode: CollaborationMode | undefined;
  if (collaborationModeAvailable) {
    collaborationMode = {
      mode: mode.kernelMode,
      settings: {
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(instructions ? { developerInstructions: instructions } : {}),
      },
    };
  } else {
    degradations.push(
      'turn/start.collaborationMode 不可用：已退回 model + effort，' +
        'Ask 模式的指令强度下降 —— 此时必须依赖 ToolContributor 过滤写工具（D8）。',
    );
  }

  const params: TurnStartParams = {
    threadId: ctx.threadId,
    input: ctx.input,
    ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
    // 降级时才把 model / effort 放到顶层：collaborationMode 存在时它优先，
    // 同时传两份只会让"到底哪个生效"变成一个需要读内核代码才能回答的问题
    ...(collaborationMode ? {} : { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }),
    ...(permissionsFieldAvailable
      ? { permissions: permissionId }
      : { approvalPolicy: 'onRequest' as const }),
  };

  if (!permissionsFieldAvailable) {
    degradations.push(
      'turn/start.permissions 不可用：已退回内置沙箱档位，企业自定义权限档不可用（F5）。',
    );
  }

  return {
    params,
    degradations,
    origin: {
      scenarioId: ctx.scenario.id,
      modeId,
      permissionId,
      ...((overrides.budgetLimit ?? ctx.scenario.budgetLimit)
        ? { budgetLimit: overrides.budgetLimit ?? ctx.scenario.budgetLimit }
        : {}),
    },
  };
}

/** v1 的三个场景（03 §2.2，与截图一致）。真源是 `config/scenarios/*.toml`，这里是兜底默认值。 */
export const BUILTIN_SCENARIOS: readonly Scenario[] = [
  {
    id: 'office',
    name: '日常办公',
    icon: 'cup',
    order: 10,
    default: true,
    mode: 'craft',
    permissions: 'evowork-workspace',
    instructionsFile: 'modes/craft-office.md',
    skills: ['documents', 'spreadsheets', 'presentations', 'charts'],
    connectors: [],
    expertsRecommended: ['report-writer', 'data-analyst', 'finance-analyst'],
    chips: [
      { label: '文档处理', icon: 'file-text', prompt: '帮我处理这些文档：', requiresFile: true },
      { label: '金融服务', icon: 'bank', prompt: '帮我分析这份财务数据：' },
      { label: '数据分析及可视化', icon: 'pie-chart', prompt: '分析这份数据并给出可视化：' },
      { label: '个人工作台', icon: 'layout', prompt: '帮我整理今天的工作安排：' },
      { label: '幻灯片', icon: 'presentation', prompt: '帮我做一份汇报幻灯片：' },
    ],
  },
  {
    id: 'code',
    name: '代码开发',
    icon: 'code',
    order: 20,
    mode: 'craft',
    permissions: 'evowork-workspace',
    instructionsFile: 'modes/craft-code.md',
    skills: [],
    chips: [
      { label: '读懂这个项目', icon: 'book', prompt: '帮我梳理这个项目的结构与关键路径：' },
      { label: '修一个 bug', icon: 'bug', prompt: '这里有个问题：' },
      { label: '写测试', icon: 'check', prompt: '为这段代码补测试：' },
    ],
  },
  {
    id: 'design',
    name: '设计创意',
    icon: 'palette',
    order: 30,
    mode: 'craft',
    permissions: 'evowork-workspace',
    instructionsFile: 'modes/craft-design.md',
    skills: ['charts'],
    chips: [
      { label: '出几个方案', icon: 'lightbulb', prompt: '围绕这个主题给我几个方案：' },
      { label: '配图', icon: 'image', prompt: '帮我生成一张配图：' },
    ],
  },
];
