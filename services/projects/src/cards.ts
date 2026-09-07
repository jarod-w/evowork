/**
 * 列表页卡片的视图组装（02 §4.3 · spec §2.1）。
 *
 * 三个数字的口径写死在这里。"差不多"的计数会让用户不信任整页 ——
 * 而他没有任何办法去核对，所以只能靠这几条规则本身立住。
 */
import { isUnderRoot } from './membership.js';
import type { ProjectRecord, RootState } from './types.js';

/** 归属判定要用的那点 thread 字段。**不引 `ProjectionRow`** —— 这个包不认识 sqlite */
export interface ThreadLite {
  readonly cwd: string | null;
  readonly archived: boolean;
  readonly recencyAt: number | null;
}

/** 同上，artifact 只要三个字段 */
export interface ArtifactLite {
  readonly path: string;
  readonly version: number;
  readonly fileState: 'PRESENT' | 'MISSING' | 'MOVED';
}

export interface ProjectCard {
  readonly id: string;
  readonly name: string;
  /** 第一个 root 的原始路径（D-P2：单根） */
  readonly rootPath: string;
  /** 中段省略后的显示串 */
  readonly rootDisplay: string;
  readonly rootState: RootState;
  readonly taskCount: number;
  readonly artifactCount: number;
  /** null = 这个空间还没有任务。页面据此**不显示这一段**，而不是显示"从未" */
  readonly recencyAt: number | null;
}

export interface BuildCardInput {
  readonly project: ProjectRecord;
  readonly threads: readonly ThreadLite[];
  readonly artifacts: readonly ArtifactLite[];
  /** 根路径存在性。注入而不是在这里 `existsSync` —— 这个包不做 I/O */
  readonly rootExists: (path: string) => boolean;
  readonly home: string;
}

/** 卡片上路径的最大显示长度（01 §5.20 项目卡变体：单行） */
const ROOT_DISPLAY_MAX = 36;

/**
 * 中段省略。**头尾都留着**：头让人知道在哪个盘/主目录下，
 * 尾是用户认出这个目录的唯一依据 —— 截掉文件夹名等于没有信息。
 *
 * 头的长度不是纯粹按剩余预算算出来的：预算算法在头段特别短、
 * 尾段又特别长时会把头挤到只剩 `~/`（连第一层目录名都看不见），
 * 那和"不知道在哪个主目录下"没有区别。所以头至少要保留到第一层
 * 目录名结束（第二个 `/` 之前），哪怕因此让总长度超出 `max` 一点点——
 * 可读性比严格贴住 `max` 更重要。
 */
export function ellipsizeMiddle(path: string, max = ROOT_DISPLAY_MAX): string {
  if (path.length <= max) return path;
  const lastSlash = path.lastIndexOf('/');
  const tail = lastSlash < 0 ? path : path.slice(lastSlash);

  const firstSlash = path.indexOf('/');
  const secondSlash = firstSlash < 0 ? -1 : path.indexOf('/', firstSlash + 1);
  const minHeadEnd = secondSlash < 0 ? Math.min(path.length, 3) : secondSlash;

  const budgetHeadEnd = max - tail.length - 1;
  const head = path.slice(0, Math.max(0, minHeadEnd, budgetHeadEnd));
  return `${head}…${tail}`;
}

export function buildProjectCard(input: BuildCardInput): ProjectCard {
  const { project, threads, artifacts, rootExists, home } = input;
  const rootPath = project.roots[0] ?? '';

  // 没有 root 的空间不是"正常但空"，它是**用不了**的：新建任务没有 cwd 可给。
  // 这里的 `rootPath !== ''` 守卫仍然是必需的 —— `rootExists` 是外部注入的
  // 任意回调，它不知道空串是退化路径（本任务的测试就故意让 `rootExists`
  // 对任何输入都返回 true）。`isUnderRoot` 自己拒绝退化 root 那道内部守卫，
  // 保护不到这里。
  const rootState: RootState = rootPath !== '' && rootExists(rootPath) ? 'ok' : 'missing';

  // 下面两处 `rootPath === ''` 守卫是**冗余**的（不是必需，但保留）：
  // `isUnderRoot('', x, home)` 折成绝对路径后必然是 `''`，命中它内部
  // 「退化 root 一律 false」的守卫，天然返回 false。留着是为了在 root
  // 为空时跳过整个数组遍历，也让读者不用去 membership.ts 里确认这一点。
  const members =
    rootPath === ''
      ? []
      : threads.filter((t) => !t.archived && t.cwd !== null && isUnderRoot(rootPath, t.cwd, home));

  const recencies = members.map((t) => t.recencyAt).filter((at): at is number => at !== null);

  /*
   * 产物按 path 去重：`artifact` 表一个文件改一次就多一行（版本链），
   * 不去重的话"改了三版"在卡片上长得和"三个产物"一模一样。
   */
  const presentPaths = new Set(
    artifacts
      .filter((a) => a.fileState === 'PRESENT')
      .filter((a) => rootPath !== '' && isUnderRoot(rootPath, a.path, home))
      .map((a) => a.path),
  );

  return {
    id: project.id,
    name: project.name,
    rootPath,
    rootDisplay: ellipsizeMiddle(rootPath),
    rootState,
    taskCount: members.length,
    artifactCount: presentPaths.size,
    recencyAt: recencies.length === 0 ? null : Math.max(...recencies),
  };
}
