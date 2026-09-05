/* eslint-disable @evowork/no-kernel-internals -- 规则的实现必须写出它要禁的那些名字（CODEX_HOME / rollout / memories）；
   这正是本仓库唯一允许的 inline disable 形态：写明理由、范围限于一个文件。 */
/**
 * K2 —— 唯一边界是 app-server JSON-RPC v2。
 *
 * 09 §2 列了三条「容易被破的地方」，它们的共同点是：都能跑通、都更快、rebase 时都会碎。
 * 靠约定守不住（约定在 deadline 前一定输），所以做成 lint 规则：
 *
 *   ① 直接读内核的 thread sqlite 做状态筛选   → 必须用自己的投影表
 *   ② 直接读 rollout JSONL 做全文搜索        → 必须用 thread/searchOccurrences + 兜底
 *   ③ 直接读 CODEX_HOME/memories 文件        → 必须用 memories/read
 *
 * 判定方式是**字符串字面量与成员访问**，不是模块图：破 K2 的典型写法是
 * `fs.readFile(path.join(process.env.CODEX_HOME, 'memories/...'))`，它不 import 任何东西。
 *
 * 允许名单只有一处：`services/kernel-adapter/**` 需要知道 CODEX_HOME 在哪（它要 spawn
 * app-server 并设环境变量），但**即使在那里也不许拼到 memories / rollout / *.db 上**。
 */

/**
 * 内核内部状态的痕迹。分两类，因为它们的误报面完全不同：
 *
 *   · `pathOnly: true`  —— 词本身是**协议方法名的一部分**，只有出现在路径里才算破线。
 *     典型：`memories/read` 是唯一正确的记忆读法（09 §2 原话），而
 *     `~/.evowork/kernel/memories` 是绕过协议。同一个词，一个是正路一个是歧路，
 *     只靠词形分不开，必须看它是不是路径。
 *   · `pathOnly: false` —— 内核的表名/库名，出现在任何位置（尤其 SQL 字符串里）都算破线。
 */
const KERNEL_STATE_PATTERNS = [
  { re: /rollout/i, hint: 'rollout 轨迹文件', pathOnly: true },
  { re: /(^|[^a-z])memories([^a-z]|$)/i, hint: 'CODEX_HOME/memories 目录', pathOnly: true },
  { re: /thread[_-]?store/i, hint: '内核 thread sqlite', pathOnly: false },
];

/**
 * 「看起来像文件系统路径」的判据。宁可漏报也不误报：误报会逼人整片 disable 规则，
 * 那比漏报更糟（一旦整片关掉，真正的破线也一起放行了）。
 */
function isPathLike(value) {
  if (/^(?:\/|~\/|\.{1,2}\/)/.test(value)) return true; // 绝对路径 / home / 相对路径
  if (/^[A-Za-z]:[\\/]/.test(value)) return true; // Windows 盘符
  if (/\.(?:evowork|codex)\b/.test(value)) return true; // 我们自己的与内核的家目录
  // 带扩展名的末段：'rollouts/abc.jsonl'、'thread_store.db'
  if (/[\\/][^\\/]*\.[A-Za-z0-9]{1,8}$/.test(value)) return true;
  return false;
}

/** 只有适配层可以知道 CODEX_HOME 的存在（它要 spawn 内核并注入环境变量）。 */
const CODEX_HOME_ALLOWED = /(^|\/)services\/kernel-adapter\//;

/** 内核 Rust crate / SDK 内部：前端与服务层都不许链接（K2、D3）。 */
const FORBIDDEN_IMPORT_RE = /(^|\/)codex-rs\/|^@openai\/codex(-|\/|$)|(^|\/)codex\/sdk\//;

const PROTOCOL_ADVICE =
  '改走 app-server JSON-RPC v2（K2）。状态筛选用本机投影表（09 §4.1），' +
  '内容搜索用 thread/searchOccurrences，记忆用 memories/read。';

/** @type {import('eslint').Rule.RuleModule} */
export const noKernelInternals = {
  meta: {
    type: 'problem',
    docs: {
      description: '禁止绕过 app-server 协议直接触碰内核内部状态（CLAUDE.md K2、设计 09 §2）',
    },
    schema: [],
    messages: {
      kernelState:
        '禁止直接触碰 {{hint}}：内核的表结构与文件布局不是契约，rebase 就会碎。' + PROTOCOL_ADVICE,
      codexHome:
        '只有 services/kernel-adapter 可以引用 CODEX_HOME（它需要 spawn 内核）。' + PROTOCOL_ADVICE,
      forbiddenImport:
        '禁止链接内核 Rust crate 或 SDK 内部（`{{source}}`）：唯一边界是 app-server JSON-RPC v2（K2/D3）。',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const normalized = filename.replaceAll('\\', '/');
    const inAdapter = CODEX_HOME_ALLOWED.test(normalized);

    /** @param {import('estree').Node} node @param {string} value */
    function checkStringValue(node, value) {
      const pathLike = isPathLike(value);
      for (const { re, hint, pathOnly } of KERNEL_STATE_PATTERNS) {
        if (pathOnly && !pathLike) continue;
        if (re.test(value)) {
          context.report({ node, messageId: 'kernelState', data: { hint } });
          return;
        }
      }
      if (!inAdapter && /CODEX_HOME/.test(value)) {
        context.report({ node, messageId: 'codexHome' });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') checkStringValue(node, node.value);
      },
      TemplateElement(node) {
        const raw = node.value.cooked ?? node.value.raw;
        if (typeof raw === 'string') checkStringValue(node, raw);
      },
      // process.env.CODEX_HOME —— 不含字符串字面量的那种写法
      MemberExpression(node) {
        if (inAdapter) return;
        if (node.property.type === 'Identifier' && node.property.name === 'CODEX_HOME') {
          context.report({ node, messageId: 'codexHome' });
        }
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source === 'string' && FORBIDDEN_IMPORT_RE.test(source)) {
          context.report({ node, messageId: 'forbiddenImport', data: { source } });
        }
      },
    };
  },
};
