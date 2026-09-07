/**
 * 任务与产物的归属判定（spec D-P3：按 cwd 落在 root 下，不按 project_id）。
 *
 * `thread_projection.project_id` 当前实际恒为空（内核没在给），只按它做的话
 * 每个空间都是 0 个任务。而 `ix_tp_cwd` 索引早就在表上了。
 */
import { normalizePath } from '@evowork/policy';

/** 去掉结尾**所有**斜杠，不是一个。`//`、`///` 都要归到同一个空串——只去一个的话
 *  `'//'` 会变成 `'/'`，退化 root 的判断就漏判了它。 */
function trimTrailing(path: string): string {
  return path.replace(/\/+$/, '');
}

/**
 * 把 `normalizePath` 折出来的 `~` 还原成真实绝对路径。
 *
 * 判定必须在**绝对空间**里做。折叠后的 `~` 是相对 home 的，而 home 本身可能是 `/`
 * （容器里 HOME 没设就会这样）——那时"所有路径"都折成 `~/…`，
 * 于是任何基于 `~` 前缀的比较都会把整个文件系统判成空间内。
 */
function toAbsolute(path: string, home: string): string {
  const absoluteHome = home.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = normalizePath(path, home);
  if (normalized === '~') return absoluteHome;
  if (normalized.startsWith('~/')) return `${absoluteHome}/${normalized.slice(2)}`;
  return normalized;
}

/**
 * `candidate` 是否落在 `root` 之内（含 root 自身）。
 *
 * 两侧都先转成绝对路径（`toAbsolute`）再判定，不在 `~` 折叠之后的字符串上比较——
 * 折叠依赖 home，而 home 可能是 `/`，那种情况下"所有路径"都会折成 `~/…`，
 * `~` 前缀就再也分不清"在空间内"和"在文件系统根下"。
 *
 * **只在路径分隔符边界上匹配** —— 裸 `startsWith` 会让 `/work` 吞掉 `/workspace`。
 */
export function isUnderRoot(root: string, candidate: string, home: string): boolean {
  const absoluteRoot = trimTrailing(toAbsolute(root, home));
  const absoluteCandidate = trimTrailing(toAbsolute(candidate, home));

  // 退化 root 的守卫：工作空间根必须命名文件系统根之下的一个真实目录，
  // 否则一条脏记录（空串、`/`、`//`、`/..`、`/.`，或者 home 恰好是 `/` 时的
  // 任意写法）就会把整个磁盘收进一个空间。
  //
  // 这是这条守卫第三次落笔了，前两次分别栽在哪：
  // 第一次判的是折叠后的 normalizedRoot —— home 是 `/` 时一切都会被折成 `~/…`，
  //   `root === '/'` 折完也不再是 `''` 或 `'/'`，守卫直接失效。
  // 第二次改判原始参数，绕开了折叠，但 `trimTrailing` 当时只去一个结尾斜杠
  //   （`'//'` 变 `'/'`，判不出来），而 `'/..'`、`'/.'` 只有在 normalizePath
  //   内部解析 `..`/`.` 之后才会归到根，原始参数上根本看不出来。
  // 现在两侧统一先转绝对路径、再一次性去掉所有结尾斜杠，两个来源的花样都在
  // 转换后收敛成同一个值，这里只需要判一次。
  if (absoluteRoot === '' || absoluteRoot === '/') return false;

  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}/`);
}
