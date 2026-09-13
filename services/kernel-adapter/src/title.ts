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
 * 请求的**框架**前缀：礼貌语与"能不能帮我"这类客套。
 *
 * 砍掉它们是 Claude Code 那条提示词规则（「leave out the request verbs ... the verb
 * carries no information and pushes the real subject out of view」）的词法版。
 *
 * ## 为什么只砍框架，**不砍内容动词**
 *
 * 那条提示词还要求砍掉 fix / add / generate 这类动词 —— 模型能这么干，是因为它知道
 * 剩下的部分是什么；**规则不知道**。「生成一份季度汇报」的「生成」砍了尚可，
 * 「删除上季度的归档」的「删除」砍了就变成另一件事。分不清就一个都不砍：
 * 保留一个多余的动词只是标题长一点，砍错一个是把标题变成谎话。
 *
 * 「请」后面跟的是 `请求` / `请假` / `请示` 这些词时不能砍 —— 否则
 * 「请求参数怎么传」会变成「求参数怎么传」。这个否定清单只在这里，改它要配一条断言。
 */
const FRAMING_PREFIX =
  /^(?:你好|您好|请问|请(?!求|假|示|柬|帖|愿)|麻烦|劳驾|帮我|帮忙|能不能|能否|可不可以|可以帮我|我想|我要|我需要|需要你|你能|你可以)[，,、：:\s]*/;

/** 句末标点。**截断的省略号是后加的**，所以这一步必须在截断之前。 */
const TRAILING_PUNCT = /[\s，,。．.？?！!；;：:、~～…]+$/;

/** 反复剥，因为客套会叠：「麻烦帮我…」是两层，「请问能不能…」也是两层。 */
function stripFraming(text: string): string {
  let out = text;
  // 三轮够用：真实输入里没见过叠四层的客套，而无界循环要额外证明它会停
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    out = out.replace(FRAMING_PREFIX, '').replace(TRAILING_PUNCT, '');
    if (out === before) break;
  }
  return out;
}

/**
 * 文本 → 标题。导出是为了单独测那几种"看着有字、其实没内容"的输入。
 *
 * 四步，顺序有意义：
 *
 * 1. **取第一个非空行**。用户粘一整段需求时，第一行几乎总是那句话的主干；
 *    把换行折成空格会得到一条横贯侧边栏的长句，反而更难认。
 * 2. **折叠空白**。行内的制表符与连续空格在 260 宽的行里只会制造空洞。
 * 3. **剥掉客套与句末标点**（见 `stripFraming`）。在截断**之前**做：
 *    「麻烦帮我」占掉 24 字里的 4 个，而它一个字的信息量都没有。
 * 4. **截断加省略号**。截断按 `Array.from` 数**码点**而不是 `length` 数
 *    UTF-16 码元 —— emoji 与部分生僻字是代理对，用 `slice` 会把它劈成两半，
 *    表现是标题末尾一个「�」。
 */
export function titleFromText(text: string, max = TITLE_MAX_CHARS): string | undefined {
  const firstLine = text.split('\n').find((line) => line.trim() !== '');
  if (firstLine === undefined) return undefined;

  const normalized = stripFraming(firstLine.trim().replace(/\s+/g, ' '));
  // 整句都是客套（「帮我」「请问？」）时这里是空的 —— 不起名，别编一个
  if (normalized === '') return undefined;

  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  return `${chars.slice(0, max).join('')}…`;
}
