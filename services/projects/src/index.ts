/**
 * @evowork/projects —— 工作空间的判定与视图逻辑。
 *
 * **不做 I/O**（README 的纪律）：sqlite 与 fs 在主进程，这里只有能被单测钉住的规则。
 */
export { isUnderRoot } from './membership.js';
export type { ProjectRecord, RootState } from './types.js';
