/**
 * 01 §9 验收项 1：「Token 表落成代码（CSS 变量 + TS 常量），零字面量样式 —— lint 规则禁止
 * hex/px 字面量出现在组件文件」。
 *
 * 为什么这条值得一条规则而不是一句约定：01 §2 的整套 token 是**有实测对比度约束**的
 * （§8.2：`--text-secondary` 在 `--bg-app` 上只有 4.59，余量 0.09）。一旦组件里出现
 * `#6E6D68` 这样的字面量，它就脱离了 token 表的约束，后续调 token 时不会跟着变，
 * 无障碍断言（§9 验收项 5）也测不到它。
 *
 * 规则只在**组件文件**上启用（由 eslint.config 的 files 决定作用域），检查两类字面量：
 *   · 颜色：#RGB / #RRGGBB / #RRGGBBAA、rgb()/rgba()/hsl()/hsla()
 *   · 尺寸：数字 + px（0px 除外 —— `0` 无单位歧义，写成 0px 也无害）
 *
 * 例外（options.allow 之外的内置例外，均有明确理由）：
 *   · `1px` 边框宽度：01 §4.5 明确「暗色下一律加 1px 描边替代阴影」，token 化 1px 只会
 *     制造一个永远等于 1 的常量。仅放行 1px，2px+ 仍需走 token（如聚焦环的 2px 是 token）。
 *   · `100%` / `100vh` 这类比例值不含 px，天然不在规则范围内。
 */

const HEX_COLOR_RE = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i;
const FUNC_COLOR_RE = /\b(?:rgba?|hsla?)\s*\(/i;
/** 捕获数值，用于放行 0px / 1px */
const PX_RE = /(?<![\w-])(\d+(?:\.\d+)?)px\b/;

const ALLOWED_PX = new Set(['0', '1']);

/** @type {import('eslint').Rule.RuleModule} */
export const noStyleLiterals = {
  meta: {
    type: 'problem',
    docs: {
      description: '组件文件里禁止颜色与 px 字面量，必须用 01 §2 的 design token',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      color:
        '组件里不许出现颜色字面量 `{{value}}`：改用 01 §2 的 token（如 var(--text-secondary)）。' +
        'token 带实测对比度约束（01 §8.2），字面量会绕过它，并让暗色与高对比模式失效。',
      px:
        '组件里不许出现 `{{value}}` 这样的 px 字面量：改用 01 §2.5 的间距刻度或 §2.3 的圆角 token。' +
        '（0px 与 1px 边框宽度除外）',
    },
  },

  create(context) {
    const allow = new Set(context.options[0]?.allow ?? []);

    /** @param {import('estree').Node} node @param {string} text */
    function check(node, text) {
      if (allow.has(text)) return;

      const hex = HEX_COLOR_RE.exec(text);
      if (hex) {
        context.report({ node, messageId: 'color', data: { value: hex[0] } });
        return;
      }
      if (FUNC_COLOR_RE.test(text)) {
        const fn = FUNC_COLOR_RE.exec(text);
        context.report({ node, messageId: 'color', data: { value: `${fn?.[0] ?? ''}…)` } });
        return;
      }
      const px = PX_RE.exec(text);
      if (px && !ALLOWED_PX.has(px[1] ?? '')) {
        context.report({ node, messageId: 'px', data: { value: px[0] } });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        const raw = node.value.cooked ?? node.value.raw;
        if (typeof raw === 'string') check(node, raw);
      },
    };
  },
};
