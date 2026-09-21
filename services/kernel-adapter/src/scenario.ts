/**
 * 场景 + 审批档 + 用户覆盖 → `turn/start` 参数（03 §2.4，Q45）。
 *
 * ## 为什么这段展开必须在适配层
 *
 * 内核有 `CollaborationModeMask` 与 `collaborationMode/list`，看起来正好能装场景。
 * **但 `list_collaboration_modes()` 返回硬编码的 builtins（仅 plan + default），不读任何配置**
 * （F3，`models-manager/src/collaboration_mode_presets.rs:16`）。所以场景目录由 EvoWork 持有，
 * 每次 `turn/start` 由这里展开成完整参数下发 —— 零内核改动、零补丁，
 * 是 CLAUDE.md §4「能放外面就不放里面」的正例。
 *
 * 优先级（03 §2.4）：**场景默认值 → 审批档 → 用户在 Composer 里的显式选择**。
 */
import type {
  ApprovalsReviewer,
  AskForApproval,
  CollaborationMode,
  ModeKind,
  TurnStartParams,
  UserInput,
} from '@evowork/protocol';

/**
 * Composer 一级模式（Q45）。三项控制「动手前要不要问你」，
 * 不是协作风格。不要再加第四项，也不要把 Ask 做成面向用户的档。
 */
export type ModeId = 'request-approval' | 'approve-for-me' | 'full-access';

/** 帮我批准未接通时的原因。UI 原样显示，适配层拒绝发送时也用这句。 */
export const AUTO_REVIEW_UNAVAILABLE_REASON = '安全自动审查还没接通';

export interface ModeDefinition {
  readonly id: ModeId;
  /** 面向用户的名字（10 §2.4） */
  readonly label: string;
  /** 一句话说明，UI 直接显示（10 §2.4） */
  readonly summary: string;
  /** Q45：三档都走 `default`，不新增 ModeKind（D8） */
  readonly kernelMode: ModeKind;
  readonly permissions: string;
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer: ApprovalsReviewer;
  /** developer instructions 片段。三档共用 craft.md；ask.md / plan.md 不进 Composer */
  readonly instructionsFile: string;
}

export const MODES: Readonly<Record<ModeId, ModeDefinition>> = Object.freeze({
  'request-approval': {
    id: 'request-approval',
    label: '请求批准',
    summary: '编辑工作空间外的文件或使用互联网时询问你',
    kernelMode: 'default',
    permissions: 'evowork-workspace',
    approvalPolicy: 'onRequest',
    approvalsReviewer: 'user',
    instructionsFile: 'modes/craft.md',
  },
  'approve-for-me': {
    id: 'approve-for-me',
    label: '帮我批准',
    summary: '仅对检测到的风险操作请求批准',
    kernelMode: 'default',
    permissions: 'evowork-workspace',
    approvalPolicy: 'onRequest',
    approvalsReviewer: 'auto_review',
    instructionsFile: 'modes/craft.md',
  },
  'full-access': {
    id: 'full-access',
    label: '完全访问',
    summary: '可以读写这台电脑上的文件并联网',
    kernelMode: 'default',
    permissions: 'evowork-full',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    instructionsFile: 'modes/craft.md',
  },
});

const MODE_IDS = Object.keys(MODES) as ModeId[];

export function isModeId(value: string | null | undefined): value is ModeId {
  return value === 'request-approval' || value === 'approve-for-me' || value === 'full-access';
}

/**
 * 把投影表 / 旧场景包里的 id 收成 Q45 三档。
 *
 * 旧的 craft / plan / ask 都落到「请求批准」：那是当时实际发出去的
 * `evowork-workspace` + `on-request` 的效果。**不会**把帮我批准收成请求批准 ——
 * 那条静默降级是 Q45 明确禁止的。
 */
export function resolveModeId(value: string | null | undefined): ModeId {
  if (isModeId(value)) return value;
  return 'request-approval';
}

export interface ModeAvailability {
  readonly id: ModeId;
  readonly allowed: boolean;
  readonly disabledReason?: string;
}

/**
 * Composer 三项的 `allowed`。帮我批准在 reviewer 不可用时禁用并给原因，
 * **不隐藏**；完全访问的平台停用走同一条。
 */
export function composerModeAvailability(input: {
  readonly approvalsReviewerAvailable?: boolean;
  readonly fullAccessAllowed?: boolean;
  readonly fullAccessDisabledReason?: string;
}): readonly ModeAvailability[] {
  const reviewerOk = input.approvalsReviewerAvailable !== false;
  const fullOk = input.fullAccessAllowed !== false;
  return MODE_IDS.map((id) => {
    if (id === 'approve-for-me' && !reviewerOk) {
      return { id, allowed: false, disabledReason: AUTO_REVIEW_UNAVAILABLE_REASON };
    }
    if (id === 'full-access' && !fullOk) {
      return {
        id,
        allowed: false,
        ...(input.fullAccessDisabledReason
          ? { disabledReason: input.fullAccessDisabledReason }
          : {}),
      };
    }
    return { id, allowed: true };
  });
}

/**
 * 帮我批准在 `approvalsReviewer` 不可用时**拒绝展开**，不许改成 `user` 发出去（Q45）。
 */
export function assertModeSendable(
  modeId: ModeId,
  approvalsReviewerAvailable: boolean,
): void {
  if (modeId === 'approve-for-me' && !approvalsReviewerAvailable) {
    throw new Error(AUTO_REVIEW_UNAVAILABLE_REASON);
  }
}

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
  /**
   * `turn/start.approvalsReviewer` 是否能下发。默认按能下发处理；
   * 不能下发时帮我批准必须在这里被拒绝，不能改成 `user` 继续发（Q45）。
   */
  readonly approvalsReviewerAvailable?: boolean;
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
 *
 * Q45：三档共用 `config/modes/craft.md`。ask.md / plan.md 不进这条路径。
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
 * · `collaborationMode` 不可用 → 退回 `model` + `effort`。Q45 三档的审批字段不受此项影响。
 * · `permissions` 不可用 → 不传该字段（也不传 `sandboxPolicy`：F5 互斥，且调用方要求
 *   不要与 permissions 同传；缺字段时同样不发明沙箱档）。
 *
 * 帮我批准在 reviewer 不可用时**抛错**，不降成请求批准。
 */
export function expandTurnStart(ctx: ExpandContext): ExpandResult {
  const overrides = ctx.overrides ?? {};
  const modeId = resolveModeId(overrides.modeId ?? ctx.scenario.mode);
  const approvalsReviewerAvailable = ctx.approvalsReviewerAvailable ?? true;
  assertModeSendable(modeId, approvalsReviewerAvailable);

  const mode = MODES[modeId];
  const degradations: string[] = [];
  const permissionId = mode.permissions;

  const model = overrides.model ?? ctx.scenario.model;
  const effort = overrides.reasoningEffort ?? ctx.scenario.reasoningEffort;
  const instructions = composeInstructions(ctx, mode);

  const collaborationModeAvailable = ctx.collaborationModeAvailable ?? true;
  const permissionsFieldAvailable = ctx.permissionsFieldAvailable ?? true;

  let collaborationMode: CollaborationMode | undefined;
  if (collaborationModeAvailable) {
    collaborationMode = {
      mode: mode.kernelMode,
      // F22：**snake_case**。`Settings` 是 v2 里唯一没有 rename_all 的结构体，
      // 而它也不 deny_unknown_fields —— 写成 camelCase 会被静默丢掉，
      // 表现是模型对、指令没生效（产品因此失去自己的身份，K5）
      settings: {
        ...(model ? { model } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(instructions ? { developer_instructions: instructions } : {}),
      },
    };
  } else {
    degradations.push(
      'turn/start.collaborationMode 不可用：已退回 model + effort。' +
        '审批三档仍按 permissions + approvalPolicy + approvalsReviewer 下发。',
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
    ...(permissionsFieldAvailable ? { permissions: permissionId } : {}),
    approvalPolicy: mode.approvalPolicy,
    approvalsReviewer: mode.approvalsReviewer,
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

/**
 * v1 的三个场景（03 §2.2，与截图一致）。真源是 `config/scenarios/*.toml`，这里是兜底默认值。
 *
 * **`model` 不能省。** 内核对 `turn/start` 要求这个字段，缺了直接回
 * `Invalid request: missing field \`model\``——而在 UI 上那就是"回车之后任务建出来了、
 * 但一句话都没有"。第一版这里漏了它（toml 里有、代码兜底里没有），
 * 于是**在读 toml 那步落地之前，兜底路径永远起不了一个回合**。
 */
export const BUILTIN_SCENARIOS: readonly Scenario[] = [
  {
    id: 'office',
    name: '日常办公',
    icon: 'cup',
    order: 10,
    default: true,
    model: 'evowork/deepseek-v4-flash',
    reasoningEffort: 'medium',
    mode: 'request-approval',
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
    model: 'evowork/deepseek-v4-flash',
    reasoningEffort: 'high',
    mode: 'request-approval',
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
    model: 'evowork/deepseek-v4-flash',
    reasoningEffort: 'medium',
    mode: 'request-approval',
    permissions: 'evowork-workspace',
    instructionsFile: 'modes/craft-design.md',
    skills: ['charts', 'ui-design'],
    chips: [
      { label: '出几个方案', icon: 'lightbulb', prompt: '围绕这个主题给我几个方案：' },
      { label: '配图', icon: 'image', prompt: '帮我生成一张配图：' },
      { label: '设计界面', icon: 'layout', prompt: '按工作台视觉语言设计这个界面：' },
    ],
  },
];
