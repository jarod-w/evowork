/**
 * 任务与产物的归属判定（spec D-P3：按 cwd 落在 root 下，不按 project_id）。
 *
 * `thread_projection.project_id` 当前实际恒为空（内核没在给），只按它做的话
 * 每个空间都是 0 个任务。而 `ix_tp_cwd` 索引早就在表上了。
 */
import { normalizePath } from '@evowork/policy';

/** 去掉结尾斜杠。`normalizePath` 会保留用户写的那个，而前缀比较不需要它 */
function trimTrailing(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * `candidate` 是否落在 `root` 之内（含 root 自身）。
 *
 * 两侧都先过 `normalizePath`：它解析 `..`、统一分隔符、把 home 折成 `~`，
 * 所以 `~/work` 与 `/Users/li/work` 在这里是同一个东西。
 *
 * **只在路径分隔符边界上匹配** —— 裸 `startsWith` 会让 `/work` 吞掉 `/workspace`。
 */
export function isUnderRoot(root: string, candidate: string, home: string): boolean {
  const normalizedRoot = trimTrailing(normalizePath(root, home));
  // 空串与根目录都不接受：一条脏记录不该把全盘任务收进一个空间
  if (normalizedRoot === '' || normalizedRoot === '/') return false;
  const normalizedCandidate = trimTrailing(normalizePath(candidate, home));
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}
