/**
 * 「项目」= 总纲的「空间 / 工作空间」。
 *
 * `roots` 是数组而 UI 只用第一个（spec D-P2：单根，但结构留多根）——
 * 内核 `turn/start` 只收一个 cwd，适配层的 `toWorkspace` 早就是"只取第一个 root"。
 */
export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly roots: readonly string[];
  /** 内核镜像成功才有。为 undefined 不影响任何功能（spec §2.3） */
  readonly kernelId?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 根路径当前状态。失效不静默处理 —— 见 spec §2.4 */
export type RootState = 'ok' | 'missing';
