/**
 * 渲染进程与主进程之间的**数据契约**（只有类型，没有实现）。
 *
 * 在此之前这份契约是分散的：`preload/index.ts` 声明了六个动作名，`app.tsx` 声明了
 * 它期望的事件形状，主进程既没实现前者、推给渲染层的又是适配层的原始事件形状。
 * 三处各自都能编译、也各自都有测试 —— 而合起来是断的（CLAUDE.md §9.1
 * 「两个模块各自对，合起来可能不对」）。放一份共享类型，是让这条缝**在类型层面出现**。
 *
 * 这里的名字一律是**语义化**的，不出现任何协议方法名（K2）。
 */

/** 04 §2.2 的八个派生状态（与 `@evowork/store` 的 `DerivedStatus` 逐字一致）。 */
export type TaskStatusView =
  'running' | 'pending' | 'planning' | 'completed' | 'failed' | 'interrupted' | 'archived' | 'idle';

export interface TaskRowView {
  readonly id: string;
  readonly title: string | null;
  readonly status: TaskStatusView;
  readonly timeLabel: string;
  readonly sectionId: string;
  readonly parentThreadId?: string | null | undefined;
  readonly hasArtifacts?: boolean | undefined;
  readonly source?: 'manual' | 'automation' | 'cli' | undefined;
  readonly cwd?: string | undefined;
  /**
   * 这个任务上一次用的模型（04 §4 的任务级设置）。
   *
   * 打开旧任务时下拉要显示**它的**模型，而不是当前选中的那个 —— 否则用户打开一个
   * 用 Kimi 跑过的任务、直接接着问一句，那一句就被悄悄发给了别的模型。
   * 「不静默换模型」这条在这里同样成立。
   */
  readonly modelId?: string | undefined;
}

export interface RenderItemView {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** 主进程推给渲染进程的 UI 事件。**渲染层只认这三种**。 */
export type RendererEvent =
  | { readonly type: 'task-created'; readonly task: TaskRowView }
  | {
      readonly type: 'task-updated';
      readonly taskId: string;
      readonly status?: TaskStatusView;
      readonly title?: string | null;
    }
  | { readonly type: 'item'; readonly taskId: string; readonly item: RenderItemView }
  /**
   * 回合失败，**带内核给的原因**。
   *
   * 单独一种事件而不是塞进 `task-updated`：状态只回答"成没成"，
   * 而用户此刻唯一需要的是"为什么"。没有它的表现是任务标着「失败」、
   * 对话里一个字都没有 —— 用户能做的只有再试一次，而再试一次也会失败。
   */
  | {
      readonly type: 'turn-failed';
      readonly taskId: string;
      readonly message: string;
      readonly details?: string | undefined;
    };

export interface ScenarioView {
  readonly id: string;
  readonly name: string;
  readonly icon?: string | undefined;
  readonly chips: readonly {
    readonly label: string;
    readonly icon?: string | undefined;
    readonly prompt: string;
    readonly requiresFile?: boolean | undefined;
  }[];
  readonly defaults: {
    readonly modelId?: string | undefined;
    readonly permissionId?: string | undefined;
    readonly mode?: 'craft' | 'plan' | 'ask' | undefined;
  };
}

export interface PermissionOptionView {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  /** F4：`allowed:false` 要**禁用并给原因**，不隐藏 */
  readonly allowed: boolean;
}

export interface CaseView {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly scenarioId?: string | undefined;
}

/**
 * 首页渲染需要的一切。
 *
 * 做成**一次调用**而不是五个：这些数据全部来自同一次内核握手（`adapter.start()` 的 catalog）
 * 加随包内容，拆开只会让首页出现"场景已经到了、权限还没到"的中间态。
 */
export interface StartupInfo {
  readonly appName: string;
  readonly appVersion: string;
  /** 本机账号名。没有登录态（Q1=A），用户区显示的就是"谁在用这台电脑" */
  readonly userName: string;
  readonly scenarios: readonly ScenarioView[];
  readonly permissions: readonly PermissionOptionView[];
  readonly cases: readonly CaseView[];
  /** 已有任务（冷启动时投影表里就有，不必等事件流） */
  readonly tasks: readonly TaskRowView[];
}

/**
 * 模型下拉的一项（01 §5.15）。
 *
 * 形状与 `services/gateway` 的 `ModelCatalogEntry` 是**两个类型**，因为它们回答
 * 两个不同的问题：那边是"网关知道什么"，这边是"下拉要画什么"。翻译在
 * `main/model-catalog.ts` 里一处完成 —— 让渲染层直接吃网关的形状，
 * 等于把一个 HTTP 契约钉死在 UI 组件上。
 */
export interface ModelOptionView {
  readonly id: string;
  /** 等宽显示的 `provider/model` */
  readonly label: string;
  readonly provider: string;
  /** 缺失的能力**保留并标 false**（灰色划除），不隐藏 —— D2「降级必须显式」 */
  readonly capabilities: readonly {
    readonly id: 'reasoning' | 'image-input' | 'parallel-tools';
    readonly label: string;
    readonly available: boolean;
  }[];
  /** 缺失能力的用户可见文案（03 §8） */
  readonly notices: readonly string[];
}

/**
 * 模型目录的读取结果。
 *
 * `unavailable` 不是错误，是一个**正常的运行状态**：网关没起、令牌不对、一家密钥都没配。
 * 它被渲染成 Composer 顶部的 danger 条并禁用发送（03 §8：模型不可用**不静默降级**，
 * 也不该等到发出一句话、任务失败之后才说）。
 */
export interface ModelCatalogResult {
  readonly models: readonly ModelOptionView[];
  readonly unavailable?: string | undefined;
}

export interface SendInput {
  readonly threadId?: string | undefined;
  readonly text: string;
  readonly scenarioId?: string | undefined;
  /**
   * 用户在 Composer 里手动选的模型（03 §2.4 的优先级最高一档）。
   *
   * 新任务时它作为 `overrides.model` 展开进 `turn/start`；已有任务时它**同时**写进
   * 任务级设置（04 §4：下一次回合生效，不追溯已发生的回合）—— 只传不存的话，
   * 用户切了模型、下一轮又悄悄换回场景默认值。
   */
  readonly modelId?: string | undefined;
}

export type ApprovalDecisionView = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ApprovalDecisionInput {
  readonly id: string;
  readonly decision: ApprovalDecisionView;
  readonly answer?: string | undefined;
  readonly optionId?: string | undefined;
}

export interface RowActionInput {
  readonly action: string;
  readonly threadId: string;
}

/** 审批卡的视图模型（10 §3.2）。适配层的 `params` 在主进程里被翻译成这些字段。 */
export interface ApprovalView {
  readonly id: string;
  readonly kind: 'command' | 'fileChange' | 'permissions' | 'userInput';
  readonly threadId: string;
  readonly reason?: string | undefined;
  readonly command?: string | undefined;
  readonly cwd?: string | undefined;
  readonly question?: string | undefined;
  readonly changes?:
    readonly { readonly path: string; readonly kind?: string | undefined }[] | undefined;
  /** 由适配层决定（10 §3.3：批量变更**不给**「本次任务内都允许」） */
  readonly allowAcceptForSession: boolean;
  readonly waitedMs?: number | undefined;
  readonly unattended?: boolean | undefined;
}
