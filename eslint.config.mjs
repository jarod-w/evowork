// @ts-check
/**
 * ESLint flat config。
 *
 * 分工：prettier 管排版，tsc 管类型，eslint 只管**会被 deadline 压垮的约定**：
 *   · K2 边界纪律（@evowork/no-kernel-internals）—— 09 §2 的三条破法
 *   · 01 §9 验收项 1 的 token-only 样式（@evowork/no-style-literals）—— 只在组件文件上开
 *   · Q14 的「不落盘正文」在 packages/logging 里由类型系统与运行时双重保证，不靠 lint
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import evowork from './tools/eslint-plugin-evowork/src/index.js';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '.kernel-drift/**',
      'patches/**',
      'docs/**/*.html',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    // 这个仓库里的每一处都跑在 Node 上（Electron 主进程、服务层、脚本、测试）；
    // 渲染层的 DOM 全局在 apps/desktop 的配置块里单独加。
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    plugins: { '@evowork': evowork },
    rules: {
      '@evowork/no-kernel-internals': 'error',

      // 未使用变量用 _ 前缀显式表达「我知道它在这儿但不用」
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // any 会让 K2 的协议边界失去意义（协议形状是唯一契约）
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // 组件文件：token-only 样式（01 §9）
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      '@evowork/no-style-literals': 'error',
    },
  },

  // token 定义本身是字面量的唯一合法归宿（01 §2 是数值真源）
  {
    files: ['packages/tokens/**/*.ts'],
    rules: {
      '@evowork/no-style-literals': 'off',
    },
  },

  // 脚本：允许 console（脚本的输出就是它的界面），且关掉 K2 规则 ——
  // kernel-drift.mjs 必须谈论 rollout / thread_store 这些名字才能报告上游漂移。
  //
  // **工具与测试不关 K2 规则**：要提这些名字时用 inline disable 并写明理由。
  // 否则"放在 test / tools 里就不算破 K2"会变成默认逃生口，而逃生口一旦存在就会被走。
  {
    files: ['scripts/**/*.{mjs,js,ts}'],
    rules: {
      'no-console': 'off',
      '@evowork/no-kernel-internals': 'off',
    },
  },
  {
    files: ['tools/**/*.js', '**/*.test.{ts,js}', '**/test/**/*.{ts,js}'],
    rules: {
      'no-console': 'off',
    },
  },
);
