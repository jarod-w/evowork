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
 *
 * **后置条件（硬约束）：返回值长度绝不超过输入长度。** `max` 只是排版预算，
 * 不是安全上限——头尾都保留的策略在某些形状下会失效，这个函数绝不能让
 * 卡片上的显示串比真实路径还长。
 */
export function ellipsizeMiddle(path: string, max = ROOT_DISPLAY_MAX): string {
  if (path.length <= max) return path;

  const lastSlash = path.lastIndexOf('/');
  // lastSlash <= 0：整串里没有分隔符，或唯一的分隔符就在开头（单段绝对路径，
  // 比如 `/一个很长的目录名`）。这两种形状都没有"中段"可省——按原逻辑
  // `tail = path.slice(lastSlash)` 会把整个输入原样当成尾巴，再在前面拼一个
  // 头上去，结果比输入还长、目录名还被印了两遍。这里改为显式处理：没有中段
  // 可省，就只留尾部，用省略号标记"前面还有一截看不见"。
  if (lastSlash <= 0) {
    const keep = Math.max(0, max - 1);
    return `…${path.slice(path.length - keep)}`;
  }

  const tail = path.slice(lastSlash);

  const firstSlash = path.indexOf('/');
  const secondSlash = path.indexOf('/', firstSlash + 1);
  const minHeadEnd = secondSlash < 0 ? Math.min(path.length, 3) : secondSlash;

  const budgetHeadEnd = max - tail.length - 1;
  const head = path.slice(0, Math.max(0, minHeadEnd, budgetHeadEnd));
  const candidate = `${head}…${tail}`;

  // 安全网：尾段本身极长时（"尾段超长不截尾"是有意的取舍），头尾拼接可能
  // 反而比原串还长——这时宁可连头也不要，只留"…" + 完整尾巴，也不能违反
  // "结果不超过输入长度"这条后置条件。
  return candidate.length < path.length ? candidate : `…${tail}`;
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
   * 产物计数：**先按 path 折成"最高 version 那一行"，再看那一行是不是 PRESENT**，
   * 顺序不能反。`artifact` 表是版本链，一个文件改一次就多一行；一个「建了又删」的
   * 文件是 v1 PRESENT + v2 MISSING —— 先滤 PRESENT 再去重的话 v1 那行还在表里，
   * 会被错算成 1 个产物，用户点开却是空的，而这正是这条规则本来要防的事。
   */
  const latestByPath = new Map<string, ArtifactLite>();
  for (const a of artifacts) {
    if (rootPath === '' || !isUnderRoot(rootPath, a.path, home)) continue;
    const current = latestByPath.get(a.path);
    if (current === undefined || a.version > current.version) {
      latestByPath.set(a.path, a);
    }
  }
  const artifactCount = Array.from(latestByPath.values()).filter(
    (a) => a.fileState === 'PRESENT',
  ).length;

  return {
    id: project.id,
    name: project.name,
    rootPath,
    rootDisplay: ellipsizeMiddle(rootPath),
    rootState,
    taskCount: members.length,
    artifactCount,
    recencyAt: recencies.length === 0 ? null : Math.max(...recencies),
  };
}
