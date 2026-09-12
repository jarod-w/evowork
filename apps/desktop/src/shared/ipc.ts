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
  /** 最近活动时间（毫秒）。侧栏时间范围筛选必须读真实时间，不能解析展示文案。 */
  readonly updatedAt: number;
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
    }
  /**
   * 「项目」那一侧变了（另一个客户端建了/删了 project）。
   * 只在停在项目列表页时才据此重拉——本机自己的增删动作直接返回新列表，不等这条事件。
   */
  | { readonly type: 'projects-changed' };

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

/**
 * 工作空间下拉的一项（EvoWork 的「空间」= 内核的 Project + cwd，见 CLAUDE.md 第 5 节）。
 *
 * `path` 可能为 null（内核允许一个 project 没有 root）——此时选它**不设 cwd**，
 * 任务落在默认目录。这一条在 UI 上要说出来，不能选完了让用户猜任务跑在哪。
 */
export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly path?: string | undefined;
  /** 根目录已失效；侧栏在用户进入任务或详情前就要给出警告。 */
  readonly rootMissing?: boolean | undefined;
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
  /**
   * 可选的工作空间。**空数组是一个正常状态**（还没建过空间，或 `project/*` 不可用），
   * 由下拉渲染成一句说明 —— 空白浮层是 2026-09-06 用户报的那个 bug。
   */
  readonly workspaces: readonly WorkspaceView[];
  /** 已有任务（冷启动时投影表里就有，不必等事件流） */
  readonly tasks: readonly TaskRowView[];
  /**
   * 走没走过首次引导（02 §9）。
   *
   * 落在 `meta` 表而不是渲染层的 localStorage：换个窗口、清个缓存都不该让
   * 用户再走一遍五步引导，而"这台机器配好了没有"本来就是本机状态。
   */
  readonly onboarded: boolean;
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
  /**
   * 用谁的凭据：`byok` / `hosted` / `private`（11 §4.2）。
   *
   * **下拉里要显示它**，因为它同时回答"这次调用花谁的钱"和"数据过谁的境"。
   * 后者是 K6 隐私叙事的一部分：一个用户以为在用自己的密钥、实际走了托管调用，
   * 是隐私承诺层面的问题，不是计费问题。
   */
  readonly credentialSource: 'byok' | 'hosted' | 'private';
  /** 能力位有没有被真实 endpoint 实测过。自定义模型恒为 false（那是用户的声明） */
  readonly verified: boolean;
  /**
   * 被企业策略停用的原因（11 §4.1 第②层）。
   *
   * 有值时这一项**仍然出现在下拉里**，禁用 + 显示这句话 —— 与 F4
   * 「`allowed:false` 要禁用并给原因，不隐藏」是同一条。
   */
  readonly denied?: string | undefined;
  /** 来自哪一层：`builtin` / `tenant` / `custom`（设置页据此决定能不能删） */
  readonly layer?: string | undefined;
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
  /**
   * 为什么不可用。渲染层据此决定下一步：没密钥就给录入框，连不上就只给重试。
   * 只给文案的话，「检查模型接入」对没配密钥的用户永远是再 fetch 一次失败。
   */
  readonly reason?: ModelUnavailableReason | undefined;
}

/** 模型目录读不到时的原因。**每一种的下一步动作都不同**，所以不能压成一个布尔值。 */
export type ModelUnavailableReason =
  'no-token' | 'no-keys' | 'unauthorized' | 'unreachable' | 'empty' | 'http' | 'broken-install';

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
  /**
   * 用户选的工作空间。主进程把它翻成 `overrides.cwd`（任务在哪个目录里跑）。
   *
   * 翻译放在主进程而不是这里传路径：渲染层不该持有绝对路径，
   * 而 id → path 的对应只有拿过 catalog 的那一侧知道。
   */
  readonly workspaceId?: string | undefined;
}

/**
 * 打开一个已有任务（04 §9）。
 *
 * 点侧边栏一行时调用。**不是** `refreshVisible`：那条只校正可见页的标题/状态，
 * 不拉对话。少了这一步，已完成任务打开后对话区是「还没有消息」—— 标题和徽章
 * 来自投影表，历史只活在当场的事件流里。
 */
export interface OpenTaskInput {
  readonly threadId: string;
}

export interface OpenTaskResult {
  readonly items: readonly RenderItemView[];
  /**
   * 权威列表没拉到时，items 是快显缓存（可能只有摘要），这条是给用户看的原因。
   * 没有这条 = 列表就是完整历史（哪怕长度为 0：这个任务真的还没有消息）。
   */
  readonly incomplete?: string | undefined;
}

/** 右侧结果工作区只取当前任务的产物，不复用全局资料库视图。 */
export interface TaskResultsView {
  readonly artifacts: readonly {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly artifactType: string;
    readonly version: number;
  }[];
}

/* ─────────────────── 三个目录式页面的数据（02 §1 的一级入口）─────────────────── */

/**
 * 资料库（06）。**形状与 `@evowork/artifacts` 的 `LibraryRow` 是两个类型** ——
 * 同一条纪律：那边回答"本机索引里有什么"，这边回答"表格要画什么"。
 */
export interface LibraryDataView {
  readonly rows: readonly {
    readonly id: string;
    readonly name: string;
    readonly source: 'artifact' | 'mine' | 'team';
    readonly owner: string;
    readonly location: string;
    readonly accessedAt: number;
    readonly artifactType?: string | undefined;
    readonly extension?: string | undefined;
  }[];
  /** 本机磁盘占用（Q17：不做云盘，配额条显示的是本机占用，动作是「清理」） */
  readonly diskUsage?:
    | {
        readonly artifactsBytes: number;
        readonly parseCacheBytes: number;
        readonly indexBytes: number;
        readonly diskFreeBytes: number;
      }
    | undefined;
}

/** 自动化列表页（07）。**含暂停的** —— 恰恰是它们需要用户处理（Q8） */
export interface AutomationRowView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly schedule: string;
  readonly timezone: string;
  /** 这台设备创建的才可编辑（Q15：其他设备只读 + 可「迁移到本机」） */
  readonly ownedByThisDevice: boolean;
  readonly consecutiveFailures?: number | undefined;
  readonly nextFireAt?: number | undefined;
}

export interface AutomationRunView {
  readonly id: string;
  readonly fireTime: number;
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'MISSED';
  readonly trigger: string;
  readonly skipReason?: string | undefined;
  readonly failureClass?: string | undefined;
  readonly originalFireTime?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly tokenUsage?: number | undefined;
  readonly artifactCount?: number | undefined;
}

export interface AutomationsDataView {
  readonly automations: readonly AutomationRowView[];
  /** 按 automation id 分组的执行历史 */
  readonly runs: Readonly<Record<string, readonly AutomationRunView[]>>;
  readonly deviceName: string;
}

/**
 * 审计（10 §6）。
 *
 * **字段全部是分类与摘要，没有正文** —— 页面与导出用的是同一份数据，
 * 而导出会让它离开这台电脑。多带一个"原始路径"很自然，但那会让一份
 * 承诺不含正文的记录突然含了。
 */
export interface AuditRecordView {
  readonly id: string;
  readonly occurredAt: number;
  readonly action: string;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly actionSummary?: string | undefined;
  readonly pathKind?: string | undefined;
  readonly pathDigest?: string | undefined;
  readonly networkTarget?: string | undefined;
  readonly approvalResult?: string | undefined;
  readonly decidedBy?: string | undefined;
  readonly guardianRisk?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly tokenUsage?: number | undefined;
}

export interface AuditDataView {
  readonly records: readonly AuditRecordView[];
  readonly retentionDays: number;
  /** 还剩几天到期时开始预警。与 `retentionDays` 一样，真源在 `@evowork/policy` */
  readonly retentionWarningDays: number;
  /** 最早一条的时间。空库为 undefined —— 页面据此说"还没有记录"而不是"最早到 1970" */
  readonly oldestAt?: number | undefined;
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

/* ─────────────────── 办公扩展的安装（08 §4）─────────────────── */

/**
 * 扩展装了没有。**它不是一个布尔值**，因为"没装"和"装了但缺东西"要给的话不一样：
 * 后者是升级路径上的真实状态（换了版本、清单加了新包），此时该说缺什么，
 * 而不是让用户从头装一遍。
 */
export interface RuntimeStatusView {
  readonly installed: boolean;
  /** 缺哪些模块。**逐个列出来** —— "装了一半"是真实会发生的状态 */
  readonly missing: readonly string[];
  /** 这台机器支不支持（架构没有对应的运行时时为 false） */
  readonly supported: boolean;
  /** 要下多少（如 "约 43 MB"）。不支持的平台上不填 */
  readonly downloadSize?: string | undefined;
}

/**
 * 安装进度。主进程按 `RENDERER_CHANNELS.runtimeProgress` 推给渲染层。
 *
 * 带 `label` 而不是让渲染层自己映射阶段名：那份文案（08 §4 要求解析与生成**统一口径**）
 * 的真源在 `@evowork/runtime-installer`，渲染层再抄一份就会分叉。
 */
export interface RuntimeProgressView {
  readonly phase: string;
  readonly label: string;
  readonly percent: number;
  readonly detail?: string | undefined;
}

/** 安装结束。失败时 `message` 是**可以直接显示**的一句话，不含堆栈。 */
export interface RuntimeInstallResultView {
  readonly ok: boolean;
  readonly failure?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * 用户在引导或首页填的厂商密钥。空字符串 = 这一家没改。
 *
 * 主进程写进 `~/.evowork/gateway.env` 之后立刻拉起本机网关。
 * **渲染层不会再读到这些值** —— 密钥只走这一次 IPC，不回传、不进日志。
 */
export interface ApplyModelAccessInput {
  readonly deepseekApiKey?: string | undefined;
  readonly moonshotApiKey?: string | undefined;
  readonly zhipuApiKey?: string | undefined;
}

/* ──────────────────── 设置页（11 §4.4，M10a）──────────────────── */

/**
 * 密钥存在哪。**它要显示给用户**（11 §4.3）：一个以为密钥被加密保存、
 * 实际走了明文兜底的用户，是我们自己造成的误解。
 */
export type SecretBackendView =
  'keychain' | 'dpapi' | 'libsecret' | 'plaintext-fallback' | 'unavailable';

/**
 * 一家内置厂商的密钥状态。
 *
 * **没有 `apiKey` 字段**（11 §12 第 2 条）。不是"返回时过滤掉了"，是类型里就没有 ——
 * 密钥进渲染进程等于进了任何一个 XSS 面，而"某处忘了过滤"是一种会真实发生的失败。
 * 用户确认自己贴对了靠后四位与一次连通性检查，不靠把 key 亮在屏幕上。
 */
export interface ProviderKeyStateView {
  readonly id: string;
  readonly label: string;
  readonly saved: boolean;
  /** 已保存时的后四位。**只有这四位** */
  readonly last4?: string | undefined;
}

/** 一条自定义模型（第③层）。同样**没有 apiKey**，只说密钥存没存。 */
export interface CustomModelView {
  readonly id: string;
  readonly displayName: string;
  /** 协议适配类型（`deepseek` / `moonshot` / `zhipu` / `private`） */
  readonly provider: string;
  readonly upstreamModel: string;
  /** endpoint。它不是密钥，用户填的、也要能看见自己填了什么 */
  readonly baseUrl: string;
  readonly keySaved: boolean;
  readonly keyLast4?: string | undefined;
}

/** 设置页「模型接入」一屏要画的全部内容。 */
export interface ModelAccessView {
  /** `local` / `hosted` / `private` —— 默认模型的上游在哪（11 §3.2，**不是"网关在哪"**） */
  readonly mode: string;
  readonly secretBackend: SecretBackendView;
  /**
   * 钥匙串不可用时要显示的那段话（11 §4.3）。有值 = **现在保存不了密钥**，
   * 页面给两个并列选项（明文保存 / 每次手填），**不替用户选**。
   */
  readonly secretNotice?: string | undefined;
  readonly providers: readonly ProviderKeyStateView[];
  readonly customModels: readonly CustomModelView[];
  /**
   * 四层合并后的结果（11 §4.1）。**与 Composer 下拉是同一份数据** ——
   * 两处各拉一次的话，"设置里明明有这个模型、下拉里却没有"这种投诉
   * 就会变成一次没人能复现的排查。
   */
  readonly models: readonly ModelOptionView[];
  /** 企业锁了自定义模型（第②层）。false 时「添加模型」禁用**并给原因**，不隐藏 */
  readonly allowCustomModels: boolean;
  readonly lockedReason?: string | undefined;
  /**
   * 是否已登录我们的账号。未登录时首页仍可用（Q30=A）。
   * 登录只解锁托管模型，不把本机任务搬到云上（11 §5.5）。
   */
  readonly signedIn: boolean;
  readonly role?: 'member' | 'admin' | undefined;
  readonly devices?: readonly DeviceView[] | undefined;
  readonly quotaUsed?: number | undefined;
  readonly quotaLimit?: number | undefined;
  /**
   * 本机当前的签名策略包状态（M10c / R11）。
   *
   * 没有包 = 个人机器，不锁 BYOK（Q30=A）。超期是只读，文案在 `message` 里。
   */
  readonly policyPack?: PolicyPackStatusView | undefined;
  /** 网关目录读不到时的原因。与 `ModelCatalogResult.unavailable` 同一句话 */
  readonly catalogUnavailable?: string | undefined;
}

/** 设置页与 Composer 看到的策略包折叠结果。没有 payload / 签名。 */
export interface PolicyPackStatusView {
  readonly status: 'none' | 'valid' | 'expiring' | 'expired';
  readonly expiresAt?: number | undefined;
  readonly message?: string | undefined;
  readonly disableShare: boolean;
  readonly disableSlots: boolean;
  readonly disabledProfiles: readonly string[];
}

/** 一台已登录设备（Q40）。吊销权威在 identity，两端走同一条 API。 */
export interface DeviceView {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly lastSeenAt: number;
  readonly revoked: boolean;
}

export interface AccountActionResult {
  readonly ok: boolean;
  readonly refused?: string | undefined;
}

/**
 * 保存一把厂商密钥。**密钥只走这一次 IPC**：不回传、不进日志。
 *
 * 单独一个动作而不是复用 `applyModelAccess`（那个收三家、给引导用）：
 * 设置页是一家一家改的，而"改一家"与"首次一起填三家"在失败处理上不同 ——
 * 前者要能单独报"这一家保存失败了"。
 */
export interface SaveProviderKeyInput {
  readonly providerId: string;
  readonly apiKey: string;
}

/** 加一条自定义模型。`apiKey` 只在这里出现一次，之后再也不回读。 */
export interface CustomModelInput {
  readonly id: string;
  readonly displayName?: string | undefined;
  /** 协议适配类型。**必选** —— endpoint 说哪种方言猜不出来（11 §4.1） */
  readonly provider: string;
  readonly upstreamModel: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly authHeader?: string | undefined;
  readonly reasoning?: boolean | undefined;
  readonly imageInput?: boolean | undefined;
  readonly parallelToolCalls?: boolean | undefined;
  readonly promptCache?: boolean | undefined;
  readonly maxContextTokens?: number | undefined;
}

/**
 * 设置页动作的统一结果。
 *
 * `refused` 是**一句要显示给用户的话**（同 `ProjectMutationResult`），不是错误码：
 * 抛错在界面上的表现是按钮转一下然后什么都没发生。
 * 成功与失败都带一份新的 `view` —— 少了它，页面要么自己猜新状态，要么再发一次请求。
 */
export interface ModelAccessMutationResult {
  readonly ok: boolean;
  readonly refused?: string | undefined;
  readonly view: ModelAccessView;
}

/** 连通性检查的结果。**说清是哪一侧的问题**，不给原始响应体 */
export interface ModelProbeResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * 设置页「用量与预算」的阶段 1 部分（Q11）。
 *
 * 托管额度随 M10b —— 这一屏现在只有本机的两个数：单任务硬预算与并发上限。
 * **并发只能往下调**（10 §5.1：机器就是资源上限，给一个能调到 8 的滑块
 * 只会让用户把机器卡住然后来抱怨）。
 */
export interface PreferencesView {
  /** 单任务 token 硬预算。undefined = 不限（定时任务另有强制预算，07 §3.2） */
  readonly taskTokenBudget?: number | undefined;
  /** 按这台机器的内存与核数算出来的上限 */
  readonly concurrencyComputed: number;
  /** 用户调过之后的生效值（永远 ≤ computed） */
  readonly concurrencyLimit: number;
}

export interface PreferencesInput {
  readonly taskTokenBudget?: number | undefined;
  readonly concurrencyLimit?: number | undefined;
}

/* ─────────────────────────── 项目（02 §4.3）─────────────────────────── */

/**
 * 列表页的一张卡。
 *
 * `recencyLabel` 可缺席：这个空间还没有任务时**不显示这一段**，
 * 而不是显示"从未" —— 后者读起来像出了什么问题。
 */
export interface ProjectCardView {
  readonly id: string;
  readonly name: string;
  /** 中段省略后的显示串。渲染层不持有完整绝对路径 */
  readonly rootDisplay: string;
  /** 路径失效。整卡转 warning，「在此空间新建任务」禁用并给原因 */
  readonly rootMissing: boolean;
  readonly taskCount: number;
  readonly artifactCount: number;
  readonly recencyLabel?: string | undefined;
}

export interface ProjectsDataView {
  readonly projects: readonly ProjectCardView[];
}

/** 详情页主区「最近的文件动作」的一行（D-P6：产物与变更合并） */
export interface ProjectFileActionView {
  readonly id: string;
  readonly name: string;
  /** 生成 / 修改。真源是 artifact.operation_kind */
  readonly action: string;
  readonly fromTaskTitle?: string | undefined;
  readonly threadId?: string | undefined;
  readonly at: number;
}

export interface ProjectAutomationView {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly status: string;
  readonly nextFireAt?: number | undefined;
}

export interface ProjectDetailView {
  readonly id: string;
  readonly name: string;
  readonly rootDisplay: string;
  readonly rootMissing: boolean;
  readonly tasks: readonly TaskRowView[];
  readonly fileActions: readonly ProjectFileActionView[];
  readonly automations: readonly ProjectAutomationView[];
}

/** 文件树的一行。`path` 是**主进程给的**，渲染层原样回传，不自己拼 */
export interface DirEntryView {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  /** 噪声目录：默认折叠 + 样式弱化，**不是隐藏** */
  readonly noisy: boolean;
}

/**
 * 增删改的结果。
 *
 * `refused` 是一条**要显示给用户的话**（如"这个目录被安全策略拦下了"），
 * 不是错误码 —— 抛错在界面上的表现是按钮转一下然后什么都没发生。
 */
export interface ProjectMutationResult {
  readonly ok: boolean;
  readonly refused?: string | undefined;
  readonly projects: readonly ProjectCardView[];
}

/** 空间记忆。`exists` 为 false 时页面显示占位说明并允许创建 */
export interface AgentsMemoView {
  readonly exists: boolean;
  readonly content: string;
}

/**
 * 写空间记忆的结果。与 `ProjectMutationResult` 同一条纪律：`refused` 是
 * **一句要显示给用户的话**，不是错误码——越界 / 末段软链 / 系统报错（EACCES、
 * ENOSPC……）都要走这里，不能让页面在写失败之后仍然显示"已保存"（C3）。
 */
export interface WriteAgentsMemoResult {
  readonly ok: boolean;
  readonly refused?: string | undefined;
}

/**
 * 技能 · 连接器目录（05）。与 `getLibrary` 同一条纪律：**按需拉，不并进 getStartup**。
 *
 * 渲染层只看这些字段。连接器的环境变量**值**不在这里（只有名），
 * 密钥不会进 XSS 面。
 */
export interface CatalogItemView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly source: 'official' | 'private' | 'local' | 'git';
  readonly sourceLabel: string;
  readonly installed: boolean;
  readonly featured: boolean;
  readonly riskLevel: 'p0' | 'p1' | 'p2';
  readonly riskLabel: string;
  readonly findings: readonly string[];
  readonly worstCase?: string | undefined;
  readonly defaultPrompt?: string | undefined;
}

export interface ConnectorView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'official' | 'custom';
  readonly transport: 'stdio' | 'sse' | 'http';
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly url?: string | undefined;
  readonly envKeys?: readonly string[] | undefined;
  readonly trusted: boolean;
  readonly status:
    'untrusted' | 'disconnected' | 'connected' | 'needs-auth' | 'failed' | 'disabled';
  readonly category: 'browser' | 'custom';
  readonly toolCount?: number | undefined;
  readonly toolPolicy: Readonly<Record<string, 'approve' | 'allow'>>;
  readonly failureSummary?: string | undefined;
  readonly disabledReason?: string | undefined;
}

export interface CatalogExpertView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: 'official' | 'local';
  readonly category: string;
  readonly sampleTasks: readonly string[];
  readonly instructions?: string | undefined;
}

export interface CatalogAppView {
  readonly id: string;
  readonly kind: 'skill' | 'connector';
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly defaultPrompt?: string | undefined;
}

export interface CatalogDataView {
  readonly skills: readonly CatalogItemView[];
  readonly connectors: readonly ConnectorView[];
  readonly experts: readonly CatalogExpertView[];
  readonly apps: readonly CatalogAppView[];
}

/**
 * 目录增删改的结果。`refused` 是一句要显示给用户的话，不是错误码。
 * `needsConfirm` = 审计要人看过再装，此时还没有拷目录。
 */
export interface CatalogMutationResult {
  readonly ok: boolean;
  readonly refused?: string | undefined;
  readonly needsConfirm?: boolean | undefined;
  readonly audit?:
    | {
        readonly skillId: string;
        readonly level: string;
        readonly findings: readonly string[];
        readonly worstCase?: string | undefined;
      }
    | undefined;
  readonly catalog: CatalogDataView;
}
