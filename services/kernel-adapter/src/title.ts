/**
 * 任务标题：**从第一条需求里就地取，不调模型**。
 *
 * ## 为什么这件事必须我们自己做
 *
 * 2026-09-06 实测（三张截图里 12 个任务全叫「未命名任务」）后核对内核：
 * `Thread.name` 是 `Option<String>`（`v2/thread_data.rs:284`），而
 * `thread/name/updated` **只在客户端显式调 `thread/name/set` 之后才发**
 * （`app-server/src/request_processors/thread_processor.rs:638-658`，
 * 唯一发送点在 `thread_set_name` 的响应之后）。
 * 内核里**没有任何自动命名的路径** —— 它把命名整个留给了 GUI。
 *
 * 所以侧边栏那 12 行不是"标题还没生成"，是**永远不会生成**。
 *
 * ## 为什么不调模型起名
 *
 * 起名要花一次模型往返：钱、延迟、以及一条把用户正文发出去的理由。
 * 而第一条需求本身就是用户对这个任务最准确的描述 —— 这与
 * `services/scheduler` 的自然语言触发解析选择同一条路（「不调模型」），
 * 也与 K6 一致：**不为了一个装饰性的字段新增出网动作**。
 *
 * 用户不满意随时可以重命名（04 §3.3 的行操作），那才是权威值。
 *
 * ## 内核是标题的真源（09 §4.1）
 *
 * 派生出来的名字**要写回内核**（`thread/name/set`），不是只塞进投影表：
 * 写回之后它进 rollout 元数据，重启还在、`thread/list?searchTerm=` 搜得到
 * （04 §3.2 的标题匹配靠的就是它）。只写投影表的话，换台机器恢复会话，
 * 12 个「未命名任务」会原样回来。
 */

import type { UserInput } from '@evowork/protocol';

/**
 * 标题长度上限。
 *
 * 侧边栏行宽 244（`LAYOUT.sidebarContentWidth`）要同时装下标题与右侧时间戳，
 * 中文按 body-sm 大致 13px/字 —— 24 字已经超出可视宽度并被 CSS 省略号截掉。
 * 截在这里是为了**别把一整段需求塞进 rollout 元数据**，不是为了排版：
 * 排版由 CSS 的 `text-overflow` 负责，两者各管各的。
 */
export const TITLE_MAX_CHARS = 24;

/**
 * 从一回合的输入里取标题。
 *
 * 只看**文本**：图片、音频、技能与 `@` 引用都不构成一个能读的名字
 * （「skill:charts」不比「未命名任务」更有信息量）。一条文本都没有时返回
 * `undefined` —— 此时**不起名**，让它保持未命名，而不是编一个
 * 「新任务 3」这样的假名字。
 */
export function deriveTaskTitle(
  input: readonly UserInput[],
  max = TITLE_MAX_CHARS,
): string | undefined {
  const text = input
    .filter((part): part is Extract<UserInput, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

  return titleFromText(text, max);
}

/**
 * 文本 → 标题。导出是为了单独测那几种"看着有字、其实没内容"的输入。
 *
 * 三步，顺序有意义：
 *
 * 1. **取第一个非空行**。用户粘一整段需求时，第一行几乎总是那句话的主干；
 *    把换行折成空格会得到一条横贯侧边栏的长句，反而更难认。
 * 2. **折叠空白**。行内的制表符与连续空格在 260 宽的行里只会制造空洞。
 * 3. **截断加省略号**。截断按 `Array.from` 数**码点**而不是 `length` 数
 *    UTF-16 码元 —— emoji 与部分生僻字是代理对，用 `slice` 会把它劈成两半，
 *    表现是标题末尾一个「�」。
 */
export function titleFromText(text: string, max = TITLE_MAX_CHARS): string | undefined {
  const firstLine = text.split('\n').find((line) => line.trim() !== '');
  if (firstLine === undefined) return undefined;

  const normalized = firstLine.trim().replace(/\s+/g, ' ');
  if (normalized === '') return undefined;

  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  return `${chars.slice(0, max).join('')}…`;
}
