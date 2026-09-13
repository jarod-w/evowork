/**
 * 用产物给任务起名（08 §2.2 的信号 ① 的副产物）。
 *
 * ## 为什么这条路值得走
 *
 * 任务标题现在是从**第一条消息**截出来的（`kernel-adapter/src/title.ts`）——
 * 用的是"用户要什么"，而真正好认的是"它产出了什么"。
 * 技能上报产物时本来就带一个人写的显示名：
 *
 * ```
 * mark_artifact --title "Q3 经营分析" --path .../Q3经营分析.docx
 * ```
 *
 * 这个名字的质量就是模型起名的质量，**因为它确实是模型写的** —— 只不过是在用户
 * 已经付过钱的那次生成里顺手写的。于是"调模型起名"的三条代价（一次往返的钱、
 * 延迟、以及一条把用户正文发出去的理由）在这里全是零：**没有新增任何调用，
 * 也没有新增任何出网路径**（K6 不受影响）。
 *
 * ## 四道闸门，每一道都是在挡一种更糟的标题
 *
 * 宁可不改名 —— 截出来的标题至少是**用户自己的字**，把它换成一个更差的名字
 * 是净损失。所以这里的默认答案是"不"。
 */
import type { ArtifactRecord } from './recognize.js';

/** 与 `TITLE_MAX_CHARS` 同源：侧边栏一行装不下更多（`kernel-adapter/src/title.ts`）。 */
const MAX_CHARS = 24;

export interface TaskTitleCandidate {
  readonly threadId: string;
  readonly title: string;
}

/**
 * 这条产物能不能给它的任务起名。不能就返回 `undefined`。
 *
 * 四道闸门：
 *
 * 1. **必须是技能上报**（信号 ①）。只有它带人写的显示名；信号 ②③ 的 `title`
 *    是 `recognize` 用**文件名**兜的底，而文件名未必比用户原话好 —— `output.docx`
 *    就比「整理一个文档向领导汇报进度」差得多。
 * 2. **必须是 `create`**。`edit` 说明任务在改一个已经存在的文件，那个文件的名字
 *    是它自己的，不是这次任务的主题。
 * 3. **必须是第一版**。v2 是同一份产物重渲染了一次，主题没变，改名只会让侧边栏跳。
 * 4. **显示名不能就是文件名**。技能没传 `--title` 时 `recognize` 拿 basename 兜底，
 *    那种情况等同于第 1 条没满足 —— 拿不到人写的名字。
 *
 * 还要有 `threadId`：定时任务在没打开任何任务时产出的文件没有归属，没法改谁的名。
 */
export function taskTitleFromArtifact(record: ArtifactRecord): TaskTitleCandidate | undefined {
  if (record.sourceSignal !== 'SKILL_REPORT') return undefined;
  if (record.operationKind !== 'create') return undefined;
  if (record.version !== 1) return undefined;
  if (!record.threadId) return undefined;

  const basename = record.path.split('/').pop() ?? record.path;
  const title = record.title.trim();
  if (title === '' || title === basename) return undefined;

  return { threadId: record.threadId, title: truncate(title, MAX_CHARS) };
}

/** 与标题派生同一套截断：按**码点**数，否则 emoji 会被劈成半个代理对。 */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}
