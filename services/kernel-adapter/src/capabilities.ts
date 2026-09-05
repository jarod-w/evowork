/**
 * 实验方法的可用性与降级（09 §3.3）。
 *
 * ## 对文档的一处修订（F18）
 *
 * 09 §3.2 第 5 步写「用 `experimentalFeature/list` 的实际返回决定 UI」，§3.3 也以此为前提。
 * **实测后这条机制不成立**：`experimentalFeature/list` 返回的是**内核运行时功能开关**
 * （`shell_tool` / `unified_exec` / `transcript_v2` 这类，2026-09-05 共 141 项，
 * 见 `codex-rs/features/src/lib.rs:893`），与「某个实验协议方法在不在」没有关系。
 *
 * 实验方法的真实门禁是两层：
 *   ① `initialize` 时声明 `capabilities.experimentalApi = true`（不声明 → 调用被拒，
 *      错误码 -32600 + `"… requires experimentalApi capability"`）；
 *   ② 上游把方法删了 → -32601 method not found。
 *
 * 因此这里的判定方式是**探测 + 失败即降级**：
 *   · 启动时探测那些**无副作用、无需上下文**的方法（`project/list` 之类）；
 *   · 需要 thread/turn 上下文的（queue、memoryMode、realtime）先记为 `unknown`，
 *     首次调用失败时转 `unavailable` 并走降级路径；
 *   · **降级一律显式**：每条降级都带一句给用户看的话，UI 必须把它显示出来，不许假装正常。
 */
import { EXPERIMENTAL_METHOD, JsonRpcCallError, type ExperimentalMethod } from '@evowork/protocol';

export type CapabilityState =
  /** 探测过，可用 */
  | 'available'
  /** 探测过或调用过，不可用 —— 走降级 */
  | 'unavailable'
  /** 还没探测（需要上下文的方法在首次使用时才知道） */
  | 'unknown';

export interface Degradation {
  /** 降级后能力还剩什么（给实现看的） */
  readonly fallback: string;
  /** 用户可见影响（给 UI 显示的，09 §3.3 第三列） */
  readonly userVisible: string;
  /**
   * 降级是否**必须**伴随另一项措施。
   * 典型例：`turn/start.collaborationMode` 不可用时，Ask 模式的指令强度下降，
   * 此时**必须**依赖 `ToolContributor` 过滤写工具（D8）—— 否则 Ask 模式名存实亡。
   */
  readonly mustAlsoDo?: string;
}

/**
 * 降级表。**与 `EXPERIMENTAL_METHOD` 是配对的**：新增一个实验方法就必须在这里给它一条兜底路径，
 * 否则"实验方法不可用时白屏"会以最平常的方式发生。`assertDegradationCoverage()` 钉住这件事。
 */
export const DEGRADATION: Readonly<Record<string, Degradation>> = Object.freeze({
  [EXPERIMENTAL_METHOD.projectList]: {
    fallback: '用本机 project_local 表自己管工作空间（只记路径与名称，不做 thread 归属）',
    userVisible: '「项目」仍可用，但任务按目录分组而不是按空间分组。',
  },
  [EXPERIMENTAL_METHOD.projectRead]: {
    fallback: '同 project/list',
    userVisible: '「项目」仍可用，但任务按目录分组而不是按空间分组。',
  },
  [EXPERIMENTAL_METHOD.projectCreate]: {
    fallback: '只在本机记录空间',
    userVisible: '新建的空间只在这台电脑上可见。',
  },
  [EXPERIMENTAL_METHOD.projectDelete]: {
    fallback: '只在本机移除记录',
    userVisible: '移除只在这台电脑上生效。',
  },
  [EXPERIMENTAL_METHOD.threadQueueAdd]: {
    fallback: '前端本地队列：执行中的输入先存本机，turn/completed 后自动发送',
    userVisible: '排队仍可用（队列只在这台电脑上）。',
  },
  [EXPERIMENTAL_METHOD.threadQueueList]: {
    fallback: '读本机队列',
    userVisible: '排队仍可用（队列只在这台电脑上）。',
  },
  [EXPERIMENTAL_METHOD.threadQueueUpdate]: {
    fallback: '改本机队列',
    userVisible: '排队仍可用（队列只在这台电脑上）。',
  },
  [EXPERIMENTAL_METHOD.threadQueueDelete]: {
    fallback: '删本机队列项',
    userVisible: '排队仍可用（队列只在这台电脑上）。',
  },
  [EXPERIMENTAL_METHOD.threadQueueReorder]: {
    fallback: '重排本机队列',
    userVisible: '排队仍可用（队列只在这台电脑上）。',
  },
  [EXPERIMENTAL_METHOD.threadQueueStart]: {
    fallback: '本机队列在 turn/completed 后自动出队',
    userVisible: '排队仍可用（队列只在这台电脑上）。',
  },
  [EXPERIMENTAL_METHOD.threadSearch]: {
    fallback: '只做标题搜索（thread/list?searchTerm）+ 本机投影表缓存的消息摘要',
    userVisible: '内容搜索暂不可用，只能按任务标题搜。',
  },
  [EXPERIMENTAL_METHOD.threadSearchOccurrences]: {
    fallback: '同 thread/search',
    userVisible: '对话内搜索暂不可用。',
  },
  [EXPERIMENTAL_METHOD.threadTimelineList]: {
    fallback: '用 thread/turns/list 代替',
    userVisible: '无（时间线由回合列表代替）。',
  },
  [EXPERIMENTAL_METHOD.threadMemoryModeSet]: {
    fallback: '用全局记忆开关代替任务级开关',
    userVisible: '记忆开关只能全局设置，不能按任务设置。',
  },
  [EXPERIMENTAL_METHOD.memoryReset]: {
    fallback: '无（不提供清空全部记忆）',
    userVisible: '「清空全部记忆」暂不可用，可逐条删除。',
  },
  [EXPERIMENTAL_METHOD.threadRealtimeStart]: {
    fallback: '隐藏麦克风按钮',
    userVisible: '语音输入不可用。',
  },
  [EXPERIMENTAL_METHOD.threadRealtimeAppendAudio]: {
    fallback: '同上',
    userVisible: '语音输入不可用。',
  },
  [EXPERIMENTAL_METHOD.threadRealtimeStop]: {
    fallback: '同上',
    userVisible: '语音输入不可用。',
  },
  [EXPERIMENTAL_METHOD.collaborationModeList]: {
    // F3：它只返回硬编码的 plan + default，对 UI 无用 —— 我们本来就不调它
    fallback: '不调用（场景包由 EvoWork 自己维护）',
    userVisible: '无。',
  },
});

/**
 * `turn/start` 上的实验**字段**（不是方法），它们的降级最需要小心。
 *
 * 与方法不同，字段不可用时请求整体会被拒（-32600），因此适配层必须能"去掉这个字段重发"。
 */
export const FIELD_DEGRADATION = Object.freeze({
  'turn/start.collaborationMode': {
    fallback: '退回 turn/start.model + effort，developer instructions 通过 additionalContext 注入',
    userVisible: 'Ask 模式的指令强度下降。',
    mustAlsoDo:
      '**必须**依赖 ToolContributor 过滤写工具（D8）——否则 Ask 模式只剩沙箱这一层，模型会反复尝试写再失败',
  },
  'turn/start.permissions': {
    fallback: '退回 sandboxPolicy（两者互斥，F5）',
    userVisible: '企业自定义权限档不可用，只能用三个内置档。',
  },
} satisfies Record<string, Degradation>);

export interface CapabilityReport {
  readonly method: string;
  readonly state: CapabilityState;
  readonly degradation?: Degradation;
  /** 为什么判定不可用：`METHOD_NOT_FOUND` | `PROBE_FAILED` | `CALL_FAILED` */
  readonly reason?: string;
}

/** 探测器：调用一个无副作用的实验方法，返回是否可用。 */
export type Prober = (method: ExperimentalMethod) => Promise<void>;

/**
 * 启动时可安全探测的方法 —— **必须无副作用、且不需要 thread/turn 上下文**。
 *
 * 其余方法（queue / memoryMode / realtime / search）都需要一个真实的 threadId，
 * 拿假 id 去探测会得到"找不到这个 thread"而不是"方法不存在"，判断反而更不准。
 * 所以它们停在 `unknown`，首次真实调用时再定性。
 */
export const PROBE_ON_STARTUP: readonly ExperimentalMethod[] = [EXPERIMENTAL_METHOD.projectList];

export class CapabilityRegistry {
  #states = new Map<string, CapabilityState>();
  #reasons = new Map<string, string>();

  constructor(private readonly onDegrade?: (report: CapabilityReport) => void) {}

  state(method: string): CapabilityState {
    return this.#states.get(method) ?? 'unknown';
  }

  isUsable(method: string): boolean {
    return this.state(method) !== 'unavailable';
  }

  markAvailable(method: string): void {
    this.#states.set(method, 'available');
    this.#reasons.delete(method);
  }

  /**
   * 判定不可用并**显式报告降级**。
   *
   * 报告是这个方法的重点：09 §3.3 的最后一句是「降级一律显式：UI 上说'这个能力当前不可用'，
   * 不假装正常」。静默降级会让用户以为功能坏了却不知道为什么，比功能缺失更伤信任。
   */
  markUnavailable(method: string, reason: string): CapabilityReport {
    this.#states.set(method, 'unavailable');
    this.#reasons.set(method, reason);
    const degradation = DEGRADATION[method];
    const report: CapabilityReport = {
      method,
      state: 'unavailable',
      reason,
      ...(degradation ? { degradation } : {}),
    };
    this.onDegrade?.(report);
    return report;
  }

  /**
   * 把一次调用失败归类。
   *
   * 三种结果，处理方式完全不同：
   *   · `-32601` → 上游删了这个方法 → 降级（这是 09 §3.3 的正常路径）
   *   · `-32600` + experimentalApi 提示 → **我们自己的 bug**，不降级，原样抛出让它响亮地失败
   *   · 其他 → 普通业务错误，原样抛出
   */
  classifyFailure(method: string, err: unknown): { degraded: boolean; report?: CapabilityReport } {
    if (err instanceof JsonRpcCallError && err.isMethodNotFound) {
      return { degraded: true, report: this.markUnavailable(method, 'METHOD_NOT_FOUND') };
    }
    return { degraded: false };
  }

  async probeStartup(probe: Prober): Promise<CapabilityReport[]> {
    const reports: CapabilityReport[] = [];
    for (const method of PROBE_ON_STARTUP) {
      try {
        await probe(method);
        this.markAvailable(method);
        reports.push({ method, state: 'available' });
      } catch (err) {
        const classified = this.classifyFailure(method, err);
        if (classified.report) {
          reports.push(classified.report);
        } else {
          // 探测失败但不是"方法不存在"（比如内核刚起来还没就绪）——保持 unknown，
          // 首次真实调用时再定性。把它错判成 unavailable 会永久关掉一个其实可用的能力。
          reports.push({ method, state: 'unknown', reason: 'PROBE_FAILED' });
        }
      }
    }
    return reports;
  }

  /** 当前所有已判定不可用的能力，供 UI 在设置里列出「当前不可用的能力」。 */
  unavailable(): CapabilityReport[] {
    return [...this.#states.entries()]
      .filter(([, state]) => state === 'unavailable')
      .map(([method]) => {
        const degradation = DEGRADATION[method];
        const reason = this.#reasons.get(method);
        return {
          method,
          state: 'unavailable' as const,
          ...(degradation ? { degradation } : {}),
          ...(reason ? { reason } : {}),
        };
      });
  }
}

/**
 * 钉住「每个实验方法都有降级路径」这条约束。
 *
 * 它在测试里被调用，也可以在启动时调用。存在的理由：新增实验方法时，人会记得改
 * `EXPERIMENTAL_METHOD`（因为不改就没法调用），但很容易忘记加降级 ——
 * 而缺降级的表现是"某天上游删了那个方法，UI 白屏且没人知道为什么"。
 */
export function assertDegradationCoverage(): void {
  const missing = Object.values(EXPERIMENTAL_METHOD).filter((m) => !DEGRADATION[m]);
  if (missing.length > 0) {
    throw new Error(
      `以下实验方法没有降级路径（09 §3.3）：${missing.join('、')}。` +
        '每个实验方法都必须有兜底 —— 否则上游哪天删掉它，UI 就白屏。',
    );
  }
}
