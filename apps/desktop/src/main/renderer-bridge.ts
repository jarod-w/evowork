/**
 * 渲染进程能做的那几件事（`RENDERER_ACTIONS`），以及推给它的三种事件。
 *
 * ## 为什么单独一个文件
 *
 * 这是 09 §3 那条边界**朝 UI 的那一半**：适配层把内核说的话翻译成语义化事件，
 * 这里再把它翻译成"界面上要变什么"。两次翻译不是重复 ——
 * 适配层的 `UiEvent` 是**任务视角**（task-status / item-delta / plan-updated…），
 * 渲染层要的是**组件视角**（哪一行要更新、哪条消息要重画）。
 * 把它们混成一层，就会出现"为了 UI 方便"往适配层加字段的压力，那正是 K2 被磨掉的方式。
 *
 * ## 这里修掉的是一条断了的链路
 *
 * `preload` 声明了六个动作、`bootstrap` 只注册了审批一个 —— 界面能渲染，
 * 但任何操作都得到 `No handler registered`，表现是**回车没有任何反应**
 * （连报错都没有：`void send()` 把 rejection 吞了）。
 * 它一直没被发现，是因为这条链路从来没有被真正拉起来过。
 */
import {
  titleFromText,
  type Adapter,
  type ApprovalDecision,
  type ApprovalReply,
  type PendingApproval,
  type UiEvent,
} from '@evowork/kernel-adapter';
/*
 * 审计保留期与预警阈值（10 §6）。
 *
 * **从 `@evowork/policy` import**，不在这里另写一个数：主进程是 node 环境，
 * 那个包的 `node:crypto` 依赖在这一侧完全没问题。渲染层拿不到它
 * （浏览器环境），所以由这里经 IPC 送过去 —— 一个真源，两条路径。
 */
import { classifyPath, RETENTION_DAYS, RETENTION_WARNING_DAYS } from '@evowork/policy';
import {
  buildProjectCard,
  ellipsizeMiddle,
  isUnderRoot,
  resolveChildPath,
  sortEntries,
  type ArtifactLite,
  type ThreadLite,
} from '@evowork/projects';
import type { Logger } from '@evowork/logging';
import type { ThreadItem } from '@evowork/protocol';
import {
  createProjectRepo,
  readMeta,
  writeMeta,
  type ItemDigestEntry,
  type ProjectionRow,
  type ProjectLocalRow,
  type Store,
} from '@evowork/store';

import type {
  AgentsMemoView,
  ApprovalDecisionInput,
  ApprovalView,
  ApplyModelAccessInput,
  AuditDataView,
  AutomationsDataView,
  CaseView,
  DirEntryView,
  LibraryDataView,
  ModelCatalogResult,
  OpenTaskInput,
  OpenTaskResult,
  ProjectCardView,
  ProjectDetailView,
  ProjectMutationResult,
  ProjectsDataView,
  RenderItemView,
  RendererEvent,
  RowActionInput,
  RuntimeInstallResultView,
  RuntimeStatusView,
  SendInput,
  StartupInfo,
  TaskRowView,
} from '../shared/ipc.js';

/** 增量能安全累加的两个通道：它们的 item 都用 `text` 承载正文。 */
const TEXT_DELTA_FIELD: Readonly<Record<string, string | undefined>> = {
  agentMessage: 'text',
  reasoning: 'text',
};

/** 相对时间（01 §5.5 的时间戳位）。**只到"天"**，再细就要每分钟重渲染整张列表。 */
export function timeLabel(at: number | null, now: number): string {
  if (at === null) return '';
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
}

/**
 * 行标题：**内核的名字优先，没有就从第一条消息现推**。
 *
 * 新任务在创建时就会被 `adapter.createTask` 写上名字，所以走不到回退这一支。
 * 回退是给**下架之前建的那些任务**的：它们的 `title` 永远是 null
 * （内核不自动命名，见 `kernel-adapter/src/title.ts`），只加自动起名的话，
 * 它们会一直是侧边栏里那 12 行「未命名任务」——用户报的正是这个。
 *
 * 回退**不写库**：它是一个展示值。真源仍然是内核（09 §4.1），用户重命名之后
 * `title` 有了值，这里就再也不看 `first_message`。
 *
 * 两条都没有时返回 null，由 UI 显示「未命名任务」—— 那时它是**真的**没名字
 * （比如一个只丢了张图片进去的任务）。
 */
export function displayTitle(row: ProjectionRow | null | undefined): string | null {
  if (!row) return null;
  return row.title ?? titleFromText(row.first_message ?? '') ?? null;
}

export function toTaskRow(row: ProjectionRow, now: number): TaskRowView {
  return {
    id: row.thread_id,
    title: displayTitle(row),
    status: row.derived_status,
    timeLabel: timeLabel(row.recency_at ?? row.updated_at, now),
    sectionId: row.section_id ?? 'ungrouped',
    parentThreadId: row.parent_thread_id,
    hasArtifacts: row.artifact_count > 0,
    source: row.automation_id ? 'automation' : 'manual',
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    // 打开旧任务时下拉要显示它自己的模型（见 `TaskRowView.modelId`）
    ...(row.model !== null ? { modelId: row.model } : {}),
  };
}

/** `meta` 表里存首次引导标记的键。**一个常量，别在两处各写一遍字符串** */
export const ONBOARDED_KEY = 'evowork.onboarded';

/**
 * 本机记录的工作空间（JSON 数组）。
 *
 * 这正是 `DEGRADATION[project/list]` 写的兜底：「用本机表自己管工作空间
 * （只记路径与名称，不做 thread 归属）」。干净机器上内核一个 project 都没有，
 * 而首运行**要求**至少选一个工作空间 —— 没有这个键，引导第②步就是死路。
 */
export const LOCAL_WORKSPACES_KEY = 'evowork.workspaces';

/** 读本机记录的工作空间路径。坏数据当作没有，不让一条脏记录挡住启动。 */
export function readLocalWorkspaces(store: Store): readonly string[] {
  const raw = readMeta(store.db, LOCAL_WORKSPACES_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 「项目」页要的 I/O 端口。
 *
 * **全部注入**，与 `pageData` / `officeRuntime` 同一条理由：这个文件的其余部分是纯翻译，
 * 而这些是真的读盘、开访达、弹目录选择框。注入之后"路径失效时界面怎么表现"
 * 能在测试里跑，不必真去建一个目录再删掉。
 *
 * **这里没有删除文件的口子**，这是刻意的：02 §4.3 的「从列表移除」是解绑。
 * 想删文件就得先改这个类型，而改类型会被 review 看见（与 `audit.ts` 同一条手法）。
 */
export interface ProjectPorts {
  readonly home: string;
  readonly rootExists: (path: string) => boolean;
  /**
   * 解析符号链接（`fs.realpath`）。读不了就返回 undefined。
   *
   * **这个端口是安全边界的一半**：`isUnderRoot` / `resolveChildPath` 是纯字符串判定，
   * 它们看不见 `<root>/link` 其实指向 `/etc`。所以每一次真的要碰盘之前，
   * 都要先 realpath、**再用同一个判定复查一遍**。少了这一步，
   * 工作空间里放一个软链就能把文件树变成全盘浏览器。
   */
  readonly realpath: (path: string) => Promise<string | undefined>;
  /** 弹目录选择框。返回 undefined = 用户取消 */
  readonly pickDirectory: () => Promise<string | undefined>;
  readonly readDir: (
    path: string,
  ) => Promise<readonly { readonly name: string; readonly isDirectory: boolean }[]>;
  /** 在访达 / 资源管理器里打开 */
  readonly openFolder: (path: string) => Promise<void>;
  /** 读不到（不存在、没权限）返回 undefined —— 不要把它和空文件混为一谈 */
  readonly readTextFile: (path: string) => Promise<string | undefined>;
  readonly writeTextFile: (path: string, content: string) => Promise<void>;
}

export interface RendererBridgeOptions {
  readonly adapter: Adapter;
  readonly store: Store;
  /**
   * 三个目录式页面的数据源（本机 sqlite）。
   *
   * 注入而不是让这个文件自己建 repo：宿主已经建过一套给调度器与产物索引用了
   * （`local-services.ts`），再建一套等于同一张表有两个入口，
   * 而"两个模块各自对、合起来不对"在这个项目里已经发生过四次（CLAUDE.md §9.1）。
   */
  readonly pageData?:
    | {
        readonly listArtifacts: () => readonly {
          readonly id: string;
          readonly path: string;
          readonly title: string;
          readonly artifactType: string;
          /** 生成 / 修改。「最近的文件动作」那一列问的是这个 */
          readonly operationKind: string;
          readonly version: number;
          readonly fileState: 'PRESENT' | 'MISSING' | 'MOVED';
          readonly threadId?: string | undefined;
          readonly createdAt: number;
        }[];
        readonly listAutomations: () => readonly Record<string, unknown>[];
        readonly listRuns: (automationId: string) => readonly Record<string, unknown>[];
        readonly listAudit: () => readonly Record<string, unknown>[];
        readonly auditOldestAt: () => number | undefined;
        readonly diskUsage?: (() => LibraryDataView['diskUsage']) | undefined;
        readonly deviceId: string;
        readonly deviceName: string;
      }
    | undefined;
  /** 把用户的决定交回给挂起的审批（F14：审批是**服务端发起的请求**，必须有人回复） */
  readonly resolveApproval?: ((id: string, reply: ApprovalReply) => void) | undefined;
  readonly logger?: Logger | undefined;
  readonly appName: string;
  readonly appVersion: string;
  readonly userName?: string | undefined;
  /** 随包分发的案例池（03 §5）。真源是 `config/showcase/*.toml`，缺省用内置兜底 */
  readonly cases?: readonly CaseView[] | undefined;
  /**
   * 读模型目录（03 §4.5 的下拉）。
   *
   * 注入而不是在这里直接 fetch：它是一次**网络调用**，而这个文件的其余部分全是
   * 纯翻译。注入之后"网关不通时界面怎么表现"能在测试里跑，不必真起一个网关。
   * 没给时下拉为空并说明原因 —— **不假装有模型可选**（03 §8）。
   */
  readonly readModelCatalog?: (() => Promise<ModelCatalogResult>) | undefined;
  /**
   * 把用户填的厂商密钥写进本机并拉起网关。
   *
   * 注入：真正的写盘与起进程在宿主里。没给时如实说这个版本不能配密钥，
   * 而不是静默丢掉用户刚贴上的 key。
   */
  readonly applyModelAccess?:
    ((input: ApplyModelAccessInput) => Promise<ModelCatalogResult>) | undefined;
  /** 打开系统目录选择框（首运行第②步）。没有它时 `pickWorkspace` 返回 undefined */
  readonly pickDirectory?: (() => Promise<string | undefined>) | undefined;
  /**
   * 办公扩展的探测与安装（08 §4）。注入而不是在这里直接调安装器：
   * 装扩展要起子进程、要下载，而这个文件其余部分全是纯翻译 ——
   * 注入之后"装不上时界面怎么表现"能在测试里跑，不必真下 40MB。
   *
   * 没给时 `getRuntimeStatus` 报 `supported: false`，引导页据此**不显示安装按钮**
   * （而不是显示一个点了没反应的）。
   */
  readonly officeRuntime?:
    | {
        readonly status: () => RuntimeStatusView;
        readonly install: () => Promise<RuntimeInstallResultView>;
      }
    | undefined;
  /** 「项目」页的 I/O 端口。没给时那十个动作如实返回空/失败，不抛错 */
  readonly projectPorts?: ProjectPorts | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * 条目"跑完了"的标记，**由这里加，不是内核给的**。
 *
 * 内核的 `item/completed` 只告诉我们"这条结束了"，条目本身没有任何状态字段
 * （`Reasoning` 就三个字段：id / summary / content）。渲染层需要区分
 * "还在想"与"想完了"，所以这个事实必须在**知道它的那一层**落到条目上 ——
 * 也就是收到 `item-completed` 的这里。
 *
 * 同理 `durationSeconds`：内核对 `commandExecution` 给 `durationMs`，
 * 对 `reasoning` 什么都不给，所以推理耗时只能由我们按
 * `item/started` → `item/completed` 的墙钟时间量。量不到就不填 ——
 * 渲染层据此改说「推理过程」而不是编一个 0 秒。
 */
export interface StreamCompletionFields {
  readonly completed: true;
  readonly durationSeconds?: number;
}

/**
 * 适配层事件 → 渲染层事件。
 *
 * 返回数组而不是单个：一条 `task-created` 在渲染层要同时给出整行数据，
 * 而有些适配层事件（`skills-changed` 这类）在当前 UI 上没有落点 —— 返回空数组，
 * **不是丢弃**：它们已经在适配层落过库、记过日志了。
 */
export function createEventTranslator(store: Store, now: () => number) {
  /** 增量累加的暂存。key = itemId，随 `item-completed` 清掉 */
  const streaming = new Map<
    string,
    { taskId: string; item: Record<string, unknown>; startedAtMs: number }
  >();

  /** 完成时把"跑完了"与（能量到的话）耗时贴到条目上。见 `StreamCompletionFields`。 */
  function completionFields(itemId: string): StreamCompletionFields {
    const held = streaming.get(itemId);
    if (held === undefined) return { completed: true };
    const seconds = Math.round((now() - held.startedAtMs) / 1000);
    // 负数只可能来自时钟回拨；不填比填一个负秒数好
    return seconds >= 0 ? { completed: true, durationSeconds: seconds } : { completed: true };
  }

  return function translate(event: UiEvent): readonly RendererEvent[] {
    switch (event.type) {
      case 'task-created': {
        const row = store.threads.get(event.threadId);
        if (!row) return [];
        return [{ type: 'task-created', task: toTaskRow(row, now()) }];
      }
      case 'task-status':
        return [{ type: 'task-updated', taskId: event.threadId, status: event.status }];
      case 'turn-completed': {
        /*
         * 回合结束时**收尾还挂着的条目**。
         *
         * 中断与失败时内核不会给这些条目补一条 `item/completed`（它们确实没完成），
         * 于是"思考中…"会永远停在那儿 —— 而任务标着「失败」。这一步把它们
         * 一次性标成完成态：耗时量得到就报，量不到就让渲染层说「推理过程」。
         * 收摊的是**这个任务**的条目，别的任务可能正跑着。
         */
        const stale: RendererEvent[] = [];
        for (const [itemId, held] of [...streaming]) {
          if (held.taskId !== event.threadId) continue;
          stale.push({
            type: 'item',
            taskId: held.taskId,
            item: { ...held.item, ...completionFields(itemId) } as unknown as RenderItemView,
          });
          streaming.delete(itemId);
        }

        // 成功的回合不用说什么；失败的必须说清楚（03 §8 / 09 §3.3「降级一律显式」）
        if (event.status !== 'failed' || !event.error) return stale;
        return [
          ...stale,
          {
            type: 'turn-failed',
            taskId: event.threadId,
            message: event.error.message,
            ...(event.error.details !== undefined ? { details: event.error.details } : {}),
          },
        ];
      }
      case 'task-renamed': {
        /*
         * 名字被**清空**时（内核发一条不带 `threadName` 的通知）不能直接把标题设成 null：
         * 那样这一行会掉回「未命名任务」，而下次启动读投影表时又会显示第一条消息 ——
         * 同一个任务在刷新前后叫两个名字。回落走 `displayTitle`，两条路径口径一致。
         */
        const title = event.title ?? displayTitle(store.threads.get(event.threadId) ?? null);
        return [{ type: 'task-updated', taskId: event.threadId, title }];
      }
      case 'item-started': {
        const item = event.item as unknown as Record<string, unknown> & {
          id: string;
          type: string;
        };
        streaming.set(item.id, {
          taskId: event.threadId,
          item: { ...item },
          startedAtMs: now(),
        });
        return [{ type: 'item', taskId: event.threadId, item }];
      }
      case 'item-completed': {
        const item = event.item as unknown as Record<string, unknown> & {
          id: string;
          type: string;
        };
        const completed = { ...item, ...completionFields(item.id) };
        streaming.delete(item.id);
        return [
          { type: 'item', taskId: event.threadId, item: completed as unknown as RenderItemView },
        ];
      }
      case 'item-delta': {
        const field = TEXT_DELTA_FIELD[event.channel];
        const held = streaming.get(event.itemId);
        // 没见过 item-started 的增量不猜形状：等 item-completed 给出完整条目
        if (field === undefined || held === undefined) return [];
        const merged = {
          ...held.item,
          [field]: `${String(held.item[field] ?? '')}${event.delta}`,
        };
        streaming.set(event.itemId, { ...held, item: merged });
        return [{ type: 'item', taskId: held.taskId, item: merged as unknown as RenderItemView }];
      }
      default:
        // 其余事件在当前 UI 上没有落点。适配层已经落库并记过日志，这里不再重复
        return [];
    }
  };
}

/**
 * 渲染动作的实现。
 *
 * 不 import electron：`bootstrap.ts` 负责把它们挂到 `ipcMain` 上，
 * 这样"发送一条需求会发生什么"能在测试里跑完整条链路（这正是它此前从未被验证的原因）。
 */
export function createRendererActions(options: RendererBridgeOptions) {
  const { adapter, store } = options;
  const now = options.now ?? (() => Date.now());

  const projects = createProjectRepo(store.db);

  /** 没注入端口时的诚实回答：功能不可用，而不是一个点了没反应的按钮 */
  const NO_PORTS = '这个构建没有接文件系统，项目功能不可用。';

  const allThreadsLite = (): readonly ThreadLite[] =>
    adapter
      .listTasks({})
      .map((t) => store.threads.get(t.threadId))
      .filter((row): row is ProjectionRow => row !== undefined)
      .map((row) => ({ cwd: row.cwd, archived: row.archived === 1, recencyAt: row.recency_at }));

  const allArtifactsLite = (): readonly ArtifactLite[] =>
    (options.pageData?.listArtifacts() ?? []).map((a) => ({
      path: a.path,
      version: a.version,
      fileState: a.fileState,
    }));

  const toCard = (row: ProjectLocalRow, ports: ProjectPorts): ProjectCardView => {
    const card = buildProjectCard({
      project: {
        id: row.id,
        name: row.name,
        roots: row.roots,
        ...(row.kernelId !== undefined ? { kernelId: row.kernelId } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      threads: allThreadsLite(),
      artifacts: allArtifactsLite(),
      rootExists: ports.rootExists,
      home: ports.home,
    });
    return {
      id: card.id,
      name: card.name,
      rootDisplay: card.rootDisplay,
      rootMissing: card.rootState === 'missing',
      taskCount: card.taskCount,
      artifactCount: card.artifactCount,
      ...(card.recencyAt !== null ? { recencyLabel: timeLabel(card.recencyAt, now()) } : {}),
    };
  };

  const cards = (ports: ProjectPorts): readonly ProjectCardView[] =>
    projects.list().map((row) => toCard(row, ports));

  /** 空间的根目录。没有 root 的空间返回 undefined —— 它做不了任何需要 cwd 的事 */
  const rootOf = (id: string): string | undefined => projects.get(id)?.roots[0];

  /**
   * 包一层 `ports.realpath`：解析失败（无论是返回 undefined 还是直接抛错）一律当成
   * "解析不了"，绝不让异常从安全判定里漏出去。
   *
   * 端口自己的约定是"读不了就返回 undefined"（见 `ProjectPorts.realpath` 的文档），
   * 真实实现（`service-host.ts`）也确实在内部 catch 了 —— 但这里是安全边界，
   * 多一层防御不依赖调用方老实遵守约定：一个第三方/测试用的 ports 实现哪怕
   * 让 `realpath` 抛错，也不能变成"没走到复查就已经读盘了"。
   */
  const safeRealpath = async (ports: ProjectPorts, path: string): Promise<string | undefined> => {
    try {
      return await ports.realpath(path);
    } catch {
      return undefined;
    }
  };

  /**
   * `<root>/AGENTS.md` 的真实路径，越界则 undefined。
   *
   * 路径**由这里拼**（不接受渲染层传任意路径），再经 realpath 复查 ——
   * 把 root 本身做成软链、或在 root 里放一个叫 AGENTS.md 的软链指向
   * `~/.ssh/authorized_keys`，字面判定都看不出来。
   */
  const agentsMemoPath = async (ports: ProjectPorts, root: string): Promise<string | undefined> => {
    const realRoot = await safeRealpath(ports, root);
    if (realRoot === undefined || !isUnderRoot(root, realRoot, ports.home)) return undefined;
    return `${realRoot.replace(/\/$/, '')}/AGENTS.md`;
  };

  /**
   * 新建空间。
   *
   * **写成独立的局部函数而不是对象上的方法**：`importProject` 与 `pickWorkspace` 都要复用它，
   * 而 `bootstrap.ts` 注册 handler 时是 `(host.actions[action] as ...)(payload)` ——
   * 一次脱离接收者的调用，`this` 在 ESM 严格模式下是 undefined。
   *
   * 顺序刻意：**先过路径闸门，再落库，最后才镜像**。
   * 闸门放在最后的话，一个被策略拒绝的目录已经写进本机表了。
   */
  const createProjectImpl = async (input: {
    readonly name: string;
    readonly path: string;
  }): Promise<ProjectMutationResult> => {
    const ports = options.projectPorts;
    if (!ports) return { ok: false, refused: NO_PORTS, projects: [] };

    const verdict = classifyPath(input.path, {
      workspaceRoot: input.path,
      home: ports.home,
    });
    if (verdict.verdict === 'hard-block') {
      /*
       * 10 §5 那条"把工作空间设在 ~/.ssh 就能绕过"正是这个入口。
       * 不在这里拦，后面所有路径策略都白做。
       */
      return {
        ok: false,
        refused: `这个目录被安全策略拦下了（${verdict.reason ?? '受保护目录'}），换一个吧。`,
        projects: cards(ports),
      };
    }

    const at = now();
    const id = `p-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const name = input.name.trim() || input.path.slice(input.path.lastIndexOf('/') + 1);
    projects.insert({ id, name, roots: [input.path], createdAt: at, updatedAt: at });

    // 镜像：失败静默（spec §2.3）。用户看到的是空间建好了
    try {
      const kernelId = await adapter.mirrorProjectCreate({
        name,
        rootPath: input.path,
        idempotencyKey: id,
      });
      if (kernelId !== undefined) projects.setKernelId(id, kernelId);
    } catch (err: unknown) {
      options.logger?.warn('desktop.project.mirror_failed', {
        method: 'project/create',
        errorClass: err instanceof Error ? err.name : 'UnknownError',
      });
    }

    return { ok: true, projects: cards(ports) };
  };

  return {
    /** 03 §1：没有 threadId 就是首页的第一条 —— 此时才 `thread/start`，所以首页不产生空任务 */
    async send(input: SendInput): Promise<{ threadId: string }> {
      const text = input.text.trim();
      if (text === '') throw new Error('空需求');
      const content = [{ type: 'text' as const, text }];

      /*
       * 工作空间 id → cwd。**在这里翻译**，渲染层只拿 id（见 `SendInput.workspaceId`）。
       *
       * 选了一个没有 root 的空间时 `path` 是 undefined —— 此时**不设 cwd**，
       * 让任务落在默认目录，而不是传一个 undefined 进 `thread/start` 假装设过。
       */
      const cwd = input.workspaceId
        ? adapter.catalog()?.workspaces.find((w) => w.id === input.workspaceId)?.path
        : undefined;

      // 用户手选的模型是优先级最高的一档（03 §2.4：场景默认 → 模式 → 用户显式选择）
      const overrides =
        input.modelId !== undefined || cwd
          ? {
              ...(input.modelId !== undefined ? { model: input.modelId } : {}),
              ...(cwd ? { cwd } : {}),
            }
          : undefined;

      if (input.threadId !== undefined) {
        /*
         * 已有任务里换模型：**先落任务级设置，再发这一回合**。
         *
         * 两件事都要做。只发不存的话，下一回合 `sendMessage` 会从投影表读回旧的
         * `row.model`，用户切了模型只在这一轮生效、下一轮又悄悄换回去；
         * 只存不发的话，这一轮还是旧模型 —— 而用户刚刚就是为了这一轮才切的。
         * （04 §4：任务级设置下一次 `turn/start` 生效，**不追溯已发生的回合**。）
         */
        if (input.modelId !== undefined) {
          adapter.setTaskSettings(input.threadId, { model: input.modelId });
        }
        await adapter.sendMessage({
          threadId: input.threadId,
          input: content,
          ...(overrides ? { overrides } : {}),
        });
        return { threadId: input.threadId };
      }
      const created = await adapter.createTask({
        input: content,
        ...(input.scenarioId !== undefined ? { scenarioId: input.scenarioId } : {}),
        ...(overrides ? { overrides } : {}),
      });
      // 新任务同样要落库：否则这个任务的第二条消息就回落到场景默认模型
      if (input.modelId !== undefined) {
        adapter.setTaskSettings(created.threadId, { model: input.modelId });
      }
      return { threadId: created.threadId };
    },

    /**
     * 模型下拉的数据（03 §4.5「启动时 + 手动刷新」）。
     *
     * 单独一个动作、不并进 `getStartup`：见 `main/model-catalog.ts` 的头注释 ——
     * 本机服务起不来与网关连不上是两种后果完全不同的失败，合成一个调用会让
     * 网关的一次超时把整个首页拖成白屏。
     */
    async listModels(): Promise<ModelCatalogResult> {
      if (!options.readModelCatalog) {
        return { models: [], unavailable: '这个版本没有配置模型网关地址，无法列出可用模型。' };
      }
      return options.readModelCatalog();
    },

    async applyModelAccess(input: ApplyModelAccessInput): Promise<ModelCatalogResult> {
      if (!options.applyModelAccess) {
        return {
          models: [],
          reason: 'no-keys',
          unavailable:
            '这个版本还不能在界面里保存模型密钥，请把密钥写进 ~/.evowork/gateway.env 后重启。',
        };
      }
      return options.applyModelAccess(input);
    },

    async interrupt(threadId: string): Promise<void> {
      await adapter.interrupt(threadId);
    },

    async decideApproval(input: ApprovalDecisionInput): Promise<void> {
      options.resolveApproval?.(input.id, {
        decision: input.decision as ApprovalDecision,
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
        ...(input.optionId !== undefined ? { optionId: input.optionId } : {}),
      });
      return Promise.resolve();
    },

    /**
     * 行操作（04 §3.3）。
     *
     * **本期只接了不需要内核参与的那几个**，其余如实记一条日志并返回 ——
     * 悄悄什么都不做会让用户以为点错了位置（09 §3.3 的同一条纪律）。
     */
    async rowAction(input: RowActionInput): Promise<void> {
      if (input.action === 'archive' || input.action === 'delete') {
        store.threads.remove(input.threadId);
        return;
      }
      options.logger?.info('desktop.row_action.unimplemented', { reason: input.action });
      return Promise.resolve();
    },

    /** 04 §3.4 第②步：只对可见页做权威字段校正（**有界**，不然筛出 800 条就是 800 个请求） */
    async refreshVisible(ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      await adapter.refreshAuthoritative(ids);
    },

    /**
     * 打开任务并拉历史（04 §9）。
     *
     * 权威列表来自 `adapter.openTask`（内部 `thread/items/list`）。失败时回落快显
     * 缓存并带上原因 —— 空对话假装"还没有消息"比这更糟。
     */
    async openTask(input: OpenTaskInput): Promise<OpenTaskResult> {
      const threadId = input.threadId?.trim();
      if (!threadId) throw new Error('没有任务 id');
      const { cached, items } = await adapter.openTask(threadId);
      try {
        const listed = await items;
        return { items: listed.map(toHistoryItem) };
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          items: cached.map(digestToRenderItem),
          incomplete: `读不到这个任务的完整历史：${reason}`,
        };
      }
    },

    /**
     * 资料库（06 §3）。**本机产物索引，不出网**（Q17：不做云盘）。
     *
     * `location` 给的是**目录**而不是完整路径：表格里一列完整路径会把名称挤没，
     * 而用户在这一列想知道的是"它在哪个工作空间"。完整路径在打开时才需要。
     */
    async getLibrary(): Promise<LibraryDataView> {
      const data = options.pageData;
      if (!data) return Promise.resolve({ rows: [] });
      const rows = data.listArtifacts().map((a) => ({
        id: a.id,
        name: a.title || basename(a.path),
        source: 'artifact' as const,
        // Q17/Q19 都不做 → 所有者恒为「我」，表格会自动隐藏这一列
        owner: '我',
        location: dirname(a.path),
        accessedAt: a.createdAt,
        artifactType: a.artifactType,
        extension: extensionOf(a.path),
      }));
      const usage = data.diskUsage?.();
      return Promise.resolve({ rows, ...(usage ? { diskUsage: usage } : {}) });
    },

    /**
     * 自动化列表 + 每条的执行历史（07）。
     *
     * **含暂停的**：连败 3 次会自动 PAUSE（Q8），而那正是需要用户去看的状态。
     * 只列启用的话，"我的定时任务怎么不跑了"没有任何入口。
     */
    async getAutomations(): Promise<AutomationsDataView> {
      const data = options.pageData;
      if (!data) return Promise.resolve({ automations: [], runs: {}, deviceName: '这台电脑' });

      const raw = data.listAutomations();
      const runs: Record<string, AutomationsDataView['runs'][string]> = {};
      const automations = raw.map((a) => {
        const id = String(a.id ?? '');
        runs[id] = data.listRuns(id).map(toRunView);
        return {
          id,
          name: String(a.name ?? ''),
          status: String(a.status ?? 'ACTIVE'),
          schedule: String(a.schedule ?? ''),
          timezone: String(a.timezone ?? ''),
          // Q15：别的设备建的只读 + 可「迁移到本机」，判据是 device_id
          ownedByThisDevice: String(a.deviceId ?? a.device_id ?? '') === data.deviceId,
          ...(typeof a.consecutiveFailures === 'number'
            ? { consecutiveFailures: a.consecutiveFailures }
            : {}),
        };
      });
      return Promise.resolve({ automations, runs, deviceName: data.deviceName });
    },

    /**
     * 审计（10 §6）。
     *
     * 这条链路 2026-09-06 之前是断的：hook 在产出记录，但没人设置
     * `EVOWORK_AUDIT_LOG`，也没人读 `audit_log` 表 —— "只写不读就是死数据"
     * （10 §6 原话）当时是"既不写也不读"。
     */
    async getAudit(): Promise<AuditDataView> {
      const data = options.pageData;
      if (!data) {
        return Promise.resolve({
          records: [],
          retentionDays: RETENTION_DAYS,
          retentionWarningDays: RETENTION_WARNING_DAYS,
        });
      }
      const oldest = data.auditOldestAt();
      return Promise.resolve({
        records: data.listAudit().map((r) => toAuditView(r)),
        retentionDays: RETENTION_DAYS,
        retentionWarningDays: RETENTION_WARNING_DAYS,
        ...(oldest !== undefined ? { oldestAt: oldest } : {}),
      });
    },

    /**
     * 选一个工作空间目录（首运行第②步，也是「项目」页做出来之前唯一的入口）。
     *
     * 选完**立刻落 `meta`**，不等引导走完：用户可能选了目录之后关掉窗口，
     * 而下次打开又从"一个工作空间都没有"开始，等于白选。
     */
    async pickWorkspace(): Promise<{ path?: string }> {
      const picked = await options.pickDirectory?.();
      if (!picked) return {};
      const next = [...new Set([...readLocalWorkspaces(store), picked])];
      writeMeta(store.db, LOCAL_WORKSPACES_KEY, JSON.stringify(next));
      return { path: picked };
    },

    /** 首次引导走完（02 §9）。落 `meta` 表 —— 换窗口、清缓存都不该让人重走一遍。 */
    async completeOnboarding(): Promise<void> {
      writeMeta(store.db, ONBOARDED_KEY, '1');
      return Promise.resolve();
    },

    /**
     * 办公扩展装了没有（08 §4）。
     *
     * **每次都真探**，不记在渲染层：用户可能在另一个窗口刚装完，也可能刚把
     * `~/.evowork/runtime/office` 删了。缓存这个状态的代价是界面说"装好了"
     * 而实际生成产物时报"没装"。
     */
    async getRuntimeStatus(): Promise<RuntimeStatusView> {
      if (!options.officeRuntime) {
        // 这个版本没接安装器：**如实说不支持**，不给一个点了没反应的按钮
        return Promise.resolve({ installed: false, missing: [], supported: false });
      }
      return Promise.resolve(options.officeRuntime.status());
    },

    /**
     * 装办公扩展。进度走 `runtimeProgress` 频道推，这里只等最终结果。
     *
     * 没接安装器时返回的是**失败 + 一句能照做的话**（去哪儿手工装），
     * 而不是抛错 —— 抛错在渲染层的表现是按钮转一下然后什么都没发生。
     */
    async installOfficeRuntime(): Promise<RuntimeInstallResultView> {
      if (!options.officeRuntime) {
        return {
          ok: false,
          failure: 'UNSUPPORTED',
          message: '这个版本还不能自动安装办公扩展。',
        };
      }
      return options.officeRuntime.install();
    },

    /* ── 项目（02 §4.3）───────────────────────────────────────────── */

    listProjects(): Promise<ProjectsDataView> {
      const ports = options.projectPorts;
      if (!ports) return Promise.resolve({ projects: [] });
      return Promise.resolve({ projects: cards(ports) });
    },

    createProject: createProjectImpl,

    /** 导入 = 弹目录选择框 + 走同一条新建路径（名字取目录名） */
    async importProject(): Promise<ProjectMutationResult> {
      const ports = options.projectPorts;
      if (!ports) return { ok: false, refused: NO_PORTS, projects: [] };
      const picked = await ports.pickDirectory();
      if (picked === undefined) return { ok: true, projects: cards(ports) };
      /*
       * 调 `createProjectImpl` 而**不是** `this.createProject`：
       * `bootstrap.ts` 注册 handler 时写的是 `(host.actions[action] as ...)(payload)` ——
       * 那是一次**脱离接收者**的调用，`this` 在 ESM 严格模式下是 undefined。
       * 写成 `this.` 的话，用户点「导入现有文件夹」会得到
       * "Cannot read properties of undefined"，而直接调 `actions.importProject()`
       * 的单测反而是过的（那时 `this` 有值）—— 测试绿、真窗口炸。
       */
      return createProjectImpl({
        name: picked.slice(picked.lastIndexOf('/') + 1) || picked,
        path: picked,
      });
    },

    async renameProject(input: {
      readonly id: string;
      readonly name: string;
    }): Promise<ProjectMutationResult> {
      const ports = options.projectPorts;
      if (!ports) return { ok: false, refused: NO_PORTS, projects: [] };
      const name = input.name.trim();
      if (name === '') {
        return { ok: false, refused: '名字不能为空。', projects: cards(ports) };
      }
      projects.rename(input.id, name, now());

      const kernelId = projects.get(input.id)?.kernelId;
      if (kernelId !== undefined) {
        try {
          await adapter.mirrorProjectUpdate({ kernelId, name });
        } catch (err: unknown) {
          options.logger?.warn('desktop.project.mirror_failed', {
            method: 'project/update',
            errorClass: err instanceof Error ? err.name : 'UnknownError',
          });
        }
      }
      return { ok: true, projects: cards(ports) };
    },

    /**
     * 从列表移除。**只解绑**：不碰磁盘文件，也不碰 artifact 索引。
     * 02 §4.3 要求二次确认文案说清这一点 —— 文案在渲染层，这里保证行为对得上。
     */
    async removeProject(input: { readonly id: string }): Promise<ProjectMutationResult> {
      const ports = options.projectPorts;
      if (!ports) return { ok: false, refused: NO_PORTS, projects: [] };
      const kernelId = projects.get(input.id)?.kernelId;
      projects.remove(input.id);
      if (kernelId !== undefined) {
        try {
          await adapter.mirrorProjectDelete(kernelId);
        } catch (err: unknown) {
          options.logger?.warn('desktop.project.mirror_failed', {
            method: 'project/delete',
            errorClass: err instanceof Error ? err.name : 'UnknownError',
          });
        }
      }
      return { ok: true, projects: cards(ports) };
    },

    async openProjectFolder(input: { readonly id: string }): Promise<void> {
      const ports = options.projectPorts;
      const root = rootOf(input.id);
      if (!ports || root === undefined) return;
      await ports.openFolder(root);
    },

    readProjectDetail(input: { readonly id: string }): Promise<ProjectDetailView | null> {
      const ports = options.projectPorts;
      const row = projects.get(input.id);
      if (!ports || !row) return Promise.resolve(null);
      const root = row.roots[0] ?? '';
      const at = now();

      const tasks = adapter
        .listTasks({})
        .map((t) => store.threads.get(t.threadId))
        .filter((r): r is ProjectionRow => r !== undefined)
        .filter((r) => r.archived === 0 && r.cwd !== null && isUnderRoot(root, r.cwd, ports.home))
        .map((r) => toTaskRow(r, at));

      const titleOf = new Map(tasks.map((t) => [t.id, t.title]));

      /*
       * D-P6：产物与变更是同一张表的同一批行，合并成「最近的文件动作」。
       * `action` 用 `operationKind`（生成 / 修改）而不是 `artifactType`（文档 / 表格）——
       * 这一列问的是"做了什么"，类型信息已经在文件名的后缀里了。
       */
      const fileActions = (options.pageData?.listArtifacts() ?? [])
        .filter((a) => root !== '' && isUnderRoot(root, a.path, ports.home))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50)
        .map((a) => ({
          id: a.id,
          name: a.path.slice(a.path.lastIndexOf('/') + 1),
          action: a.operationKind,
          at: a.createdAt,
          // 任务不在这个空间里（或已归档）时就没有标题可给 —— 那一格留空，不编一个
          ...(a.threadId !== undefined && titleOf.get(a.threadId) != null
            ? { fromTaskTitle: titleOf.get(a.threadId) as string, threadId: a.threadId }
            : {}),
        }));

      const automations = (options.pageData?.listAutomations() ?? [])
        .filter((raw) => {
          const list = raw.workspaces;
          const paths = Array.isArray(list) ? (list as unknown[]) : [];
          return paths.some(
            (p) => typeof p === 'string' && root !== '' && isUnderRoot(root, p, ports.home),
          );
        })
        .map((raw) => ({
          id: String(raw.id ?? ''),
          name: String(raw.name ?? ''),
          schedule: String(raw.schedule ?? ''),
          status: String(raw.status ?? ''),
        }));

      return Promise.resolve({
        id: row.id,
        name: row.name,
        rootDisplay: ellipsizeMiddle(root),
        rootMissing: root === '' || !ports.rootExists(root),
        tasks,
        fileActions,
        automations,
      });
    },

    /**
     * 文件树展开一层（D-P5：懒加载）。
     *
     * **越界时根本不去读盘**，不是读了再过滤：`resolveChildPath` 返回 null
     * 就直接给空数组。渲染层传过来的字符串不可信。
     */
    async listProjectDir(input: {
      readonly id: string;
      readonly path?: string | undefined;
    }): Promise<readonly DirEntryView[]> {
      const ports = options.projectPorts;
      const root = rootOf(input.id);
      if (!ports || root === undefined) return [];
      const target = resolveChildPath(root, input.path ?? root, ports.home);
      if (target === null) return [];
      /*
       * 字符串判定过了还不够：`<root>/link` 在字面上完全合规，而它可能指向 /etc。
       * 所以 realpath 之后**用同一个判定再过一遍**，两道都过才读。
       */
      const real = await safeRealpath(ports, target);
      if (real === undefined || !isUnderRoot(root, real, ports.home)) return [];
      const entries = await ports.readDir(real);
      return sortEntries(entries).map((e) => ({
        name: e.name,
        path: `${target.replace(/\/$/, '')}/${e.name}`,
        isDirectory: e.isDirectory,
        noisy: e.noisy,
      }));
    },

    async readAgentsMemo(input: { readonly id: string }): Promise<AgentsMemoView> {
      const ports = options.projectPorts;
      const root = rootOf(input.id);
      if (!ports || root === undefined) return { exists: false, content: '' };
      const memoPath = await agentsMemoPath(ports, root);
      if (memoPath === undefined) return { exists: false, content: '' };
      const content = await ports.readTextFile(memoPath);
      // 读不到与空文件是两回事：前者页面说"还没有"，后者是用户自己清空的
      return content === undefined ? { exists: false, content: '' } : { exists: true, content };
    },

    /**
     * 写空间记忆。**路径固定拼成 `<root>/AGENTS.md`**，不接受渲染层传任意路径 ——
     * 接受的话渲染层就能让主进程写盘任意文件。
     */
    async writeAgentsMemo(input: {
      readonly id: string;
      readonly content: string;
    }): Promise<{ readonly ok: boolean }> {
      const ports = options.projectPorts;
      const root = rootOf(input.id);
      if (!ports || root === undefined) return { ok: false };
      const memoPath = await agentsMemoPath(ports, root);
      if (memoPath === undefined) return { ok: false };
      await ports.writeTextFile(memoPath, input.content);
      return { ok: true };
    },

    /** 首页要渲染的一切，一次给全 */
    async getStartup(): Promise<StartupInfo> {
      const catalog = adapter.catalog();
      const at = now();
      return Promise.resolve({
        appName: options.appName,
        appVersion: options.appVersion,
        /*
         * 用户名取本机账号。
         *
         * Q1=A 之下没有登录态（identity 服务还没开始），而 01 §5.7 的用户区要一个名字。
         * 取本机账号是唯一诚实的答案：这就是"谁在用这台电脑"。它不出本机（K6）。
         */
        userName: options.userName ?? '本机用户',
        scenarios: (catalog?.scenarios ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          icon: s.icon,
          chips: (s.chips ?? []).map((c) => ({
            label: c.label,
            icon: c.icon,
            prompt: c.prompt,
            requiresFile: c.requiresFile,
          })),
          defaults: {
            modelId: s.model,
            permissionId: s.permissions,
            mode: s.mode,
          },
        })),
        // F4：`allowed:false` 的档位**保留**，由 UI 禁用并给原因
        permissions: (catalog?.permissionProfiles ?? []).map((p) => ({
          id: p.id,
          label: p.id,
          ...(p.description ? { description: p.description } : {}),
          allowed: p.allowed,
        })),
        cases: options.cases ?? [],
        onboarded: readMeta(store.db, ONBOARDED_KEY) === '1',
        /*
         * 工作空间 = 内核的 project **加上**本机自己记的那些。
         *
         * 后者是 `DEGRADATION[project/list]` 写明的兜底，也是干净机器上唯一的来源：
         * 内核一个 project 都没有，而首运行要求至少选一个。只取内核那一份的话，
         * 用户在引导里选的目录选完就消失了。
         */
        workspaces: [
          ...(catalog?.workspaces ?? []).map((w) => ({
            id: w.id,
            name: w.name,
            ...(w.path !== null ? { path: w.path } : {}),
          })),
          ...readLocalWorkspaces(store)
            .filter((path) => !(catalog?.workspaces ?? []).some((w) => w.path === path))
            .map((path) => ({
              id: `local:${path}`,
              name: path.slice(path.lastIndexOf('/') + 1) || path,
              path,
            })),
        ],
        tasks: adapter
          .listTasks({})
          .map((t) => store.threads.get(t.threadId))
          .filter((row): row is ProjectionRow => row !== undefined)
          .map((row) => toTaskRow(row, at)),
      });
    },
  };
}

export type RendererActions = ReturnType<typeof createRendererActions>;

/**
 * 历史条目一律标成已完成。
 *
 * 刷新后从 `thread/items/list` 读出来的推理条目没有 `item/started→completed`
 * 的墙钟时间，渲染层据此说「推理过程」而不是永远停在「思考中…」。
 */
export function toHistoryItem(item: ThreadItem): RenderItemView {
  return { ...(item as unknown as RenderItemView), completed: true };
}

/** 快显缓存 → 能画出来的条目。摘要不是正文副本（09 §4.2），只在权威列表失败时用。 */
export function digestToRenderItem(entry: ItemDigestEntry): RenderItemView {
  const summary = entry.summary ?? '';
  if (entry.itemType === 'userMessage') {
    return {
      id: entry.itemId,
      type: 'userMessage',
      completed: true,
      content: [{ type: 'text', text: summary }],
    };
  }
  if (entry.itemType === 'agentMessage') {
    return { id: entry.itemId, type: 'agentMessage', completed: true, text: summary };
  }
  return {
    id: entry.itemId,
    type: entry.itemType,
    completed: true,
    ...(summary !== '' ? { summary } : {}),
  };
}

/* ─────────────────── 三个页面的行翻译（纯函数，单独可测）─────────────────── */

/** 路径的最后一段。不用 `node:path` 是因为这几个函数也被渲染层的测试直接调 */
function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? path : path.slice(cut + 1);
}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/** 扩展名（不含点）。没有扩展名返回 undefined —— 不编一个空串当"有扩展名" */
function extensionOf(path: string): string | undefined {
  const name = basename(path);
  const cut = name.lastIndexOf('.');
  return cut > 0 ? name.slice(cut + 1).toLowerCase() : undefined;
}

/**
 * `automation_run` 行 → 执行历史行（07 §5）。
 *
 * **跳过与漏跑分开**：`SKIPPED` 是策略生效（关机不执行、并发已满），
 * `MISSED` 是真的漏了。两者归一类的话，关机一夜漏跑 3 次看起来像"失败 3 次"，
 * 用户会去查任务本身，而那里什么问题都没有。
 */
export function toRunView(
  raw: Record<string, unknown>,
): AutomationsDataView['runs'][string][number] {
  const num = (k: string): number | undefined =>
    typeof raw[k] === 'number' ? (raw[k] as number) : undefined;
  const str = (k: string): string | undefined =>
    typeof raw[k] === 'string' ? (raw[k] as string) : undefined;
  const status = str('status') ?? str('run_status') ?? 'RUNNING';
  return {
    id: String(raw.id ?? ''),
    fireTime: num('fireTime') ?? num('fire_time') ?? 0,
    status: (['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'MISSED'] as const).includes(
      status as never,
    )
      ? (status as 'RUNNING')
      : 'RUNNING',
    trigger: str('trigger') ?? 'schedule',
    ...((str('skipReason') ?? str('skip_reason'))
      ? { skipReason: str('skipReason') ?? str('skip_reason') }
      : {}),
    ...((str('failureClass') ?? str('failure_class'))
      ? { failureClass: str('failureClass') ?? str('failure_class') }
      : {}),
    ...((num('originalFireTime') ?? num('original_fire_time'))
      ? { originalFireTime: num('originalFireTime') ?? num('original_fire_time') }
      : {}),
    ...((num('durationMs') ?? num('duration_ms'))
      ? { durationMs: num('durationMs') ?? num('duration_ms') }
      : {}),
    ...((num('tokenUsage') ?? num('token_usage'))
      ? { tokenUsage: num('tokenUsage') ?? num('token_usage') }
      : {}),
    ...((num('artifactCount') ?? num('artifact_count'))
      ? { artifactCount: num('artifactCount') ?? num('artifact_count') }
      : {}),
  };
}

/**
 * `audit_log` 行 → 审计页的一行。
 *
 * **逐字段挑，不整体展开**：页面与导出用的是同一份数据，而导出会让它离开这台电脑。
 * `{...raw}` 会把表里任何新增列原样带出去 —— 而 10 §6 的承诺是"不含正文"。
 */
export function toAuditView(raw: Record<string, unknown>): AuditDataView['records'][number] {
  const num = (k: string): number | undefined =>
    typeof raw[k] === 'number' ? (raw[k] as number) : undefined;
  const str = (k: string): string | undefined =>
    typeof raw[k] === 'string' ? (raw[k] as string) : undefined;
  const keys = [
    'threadId',
    'turnId',
    'itemId',
    'toolName',
    'actionSummary',
    'pathKind',
    'pathDigest',
    'networkTarget',
    'approvalResult',
    'decidedBy',
    'guardianRisk',
  ] as const;
  const optional: Record<string, string> = {};
  for (const k of keys) {
    const v = str(k);
    if (v !== undefined) optional[k] = v;
  }
  return {
    id: String(raw.id ?? ''),
    occurredAt: num('occurredAt') ?? 0,
    action: str('action') ?? 'unknown',
    ...optional,
    ...(num('exitCode') !== undefined ? { exitCode: num('exitCode') } : {}),
    ...(num('tokenUsage') !== undefined ? { tokenUsage: num('tokenUsage') } : {}),
  };
}

/**
 * `PendingApproval` → 审批卡视图（10 §3.2）。
 *
 * 适配层刻意把 `params` 原样带过来（它不知道 UI 要画什么），翻译在这里做。
 * **`reason` 缺失时不编一个** —— 审批卡自己会显式说明"没有给出原因"，
 * 而这正是我们希望在内核少给字段时看到的表现。
 */
export function toApprovalView(
  approval: PendingApproval,
  allowAcceptForSession: boolean,
  now: number,
): ApprovalView {
  const p = approval.params;
  const str = (key: string): string | undefined =>
    typeof p[key] === 'string' ? (p[key] as string) : undefined;
  const changes = Array.isArray(p.changes)
    ? (p.changes as readonly Record<string, unknown>[]).map((c) => ({
        path: String(c.path ?? ''),
        ...(typeof c.kind === 'string' ? { kind: c.kind } : {}),
      }))
    : undefined;

  return {
    id: approval.id,
    kind: approval.kind,
    threadId: approval.threadId,
    ...(str('reason') !== undefined ? { reason: str('reason') } : {}),
    ...(str('command') !== undefined ? { command: str('command') } : {}),
    ...(str('cwd') !== undefined ? { cwd: str('cwd') } : {}),
    ...(str('question') !== undefined ? { question: str('question') } : {}),
    ...(changes ? { changes } : {}),
    allowAcceptForSession,
    waitedMs: Math.max(0, now - approval.receivedAtMs),
    unattended: approval.unattended,
  };
}
