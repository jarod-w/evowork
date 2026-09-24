import { randomUUID } from 'node:crypto';
import { ComputerUseError } from './protocol.js';

/** 来自 Helper 的观测元数据，不存 AX 正文、标题或截图。 */
export interface WindowIdentity {
  app: string;
  processId: number;
  windowId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
interface Observation {
  id: string;
  at: number;
  window: WindowIdentity;
  elements: Set<number>;
  coordinateFallback: boolean;
}

/** 每个实例属于一个可信 thread/turn；宿主负责互斥和生命周期。 */
export class ComputerUseSession {
  private observation: Observation | undefined;
  private stopped = false;
  private writes = 0;
  private unchanged = 0;
  private failures = 0;
  private lastFailure: string | undefined;
  constructor(
    readonly threadId: string,
    readonly turnId: string,
    private readonly now = () => performance.now(),
  ) {}

  observe(window: WindowIdentity, elements: readonly number[], coordinateFallback = false): string {
    this.assertActive();
    const id = randomUUID();
    this.observation = {
      id,
      at: this.now(),
      window: { ...window },
      elements: new Set(elements),
      coordinateFallback,
    };
    return id;
  }

  /** 在原生调用之前消费状态，失败也不能重用，防止并发动作与部分成功后的重试。 */
  consume(
    stateId: string,
    window: WindowIdentity,
    target: { element_index?: number; x?: number; y?: number } = {},
  ): { warnBudget: boolean } {
    this.assertActive();
    const state = this.observation;
    this.observation = undefined;
    if (
      !state ||
      state.id !== stateId ||
      this.now() - state.at >= 30000 ||
      (Object.keys(state.window) as (keyof WindowIdentity)[]).some(
        (key) => state.window[key] !== window[key],
      )
    ) {
      throw new ComputerUseError('STALE_STATE');
    }
    if (target.element_index !== undefined) {
      if (target.x !== undefined || target.y !== undefined)
        throw new ComputerUseError('POLICY_DENIED');
      if (!state.elements.has(target.element_index))
        throw new ComputerUseError('ELEMENT_NOT_FOUND');
    } else if (target.x !== undefined || target.y !== undefined) {
      if (
        !state.coordinateFallback ||
        !Number.isFinite(target.x) ||
        !Number.isFinite(target.y) ||
        target.x! < 0 ||
        target.y! < 0 ||
        target.x! >= window.width ||
        target.y! >= window.height
      ) {
        throw new ComputerUseError('POLICY_DENIED');
      }
    }
    if (this.writes >= 100) {
      this.stop();
      throw new ComputerUseError('POLICY_DENIED');
    }
    this.writes++;
    return { warnBudget: this.writes >= 80 };
  }

  /** 只接受结果码和是否变化，不接受窗口正文作为循环检测键。 */
  complete(changed: boolean, failure?: string): void {
    this.unchanged = changed ? 0 : this.unchanged + 1;
    this.failures =
      failure === undefined ? 0 : failure === this.lastFailure ? this.failures + 1 : 1;
    this.lastFailure = failure;
    if (this.unchanged >= 10 || this.failures >= 5) this.stop();
  }
  stop(): void {
    this.stopped = true;
    this.observation = undefined;
  }
  private assertActive(): void {
    if (this.stopped) throw new ComputerUseError('USER_STOPPED');
  }
}
