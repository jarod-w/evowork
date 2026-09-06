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

export interface SendInput {
  readonly threadId?: string | undefined;
  readonly text: string;
  readonly scenarioId?: string | undefined;
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
