/* eslint-disable @evowork/no-kernel-internals -- 规则自身的测试用例必须包含被禁的字符串 */
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import { noKernelInternals } from '../src/no-kernel-internals.js';
import { noStyleLiterals } from '../src/no-style-literals.js';

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
});

describe('no-kernel-internals（K2 边界纪律）', () => {
  it('拒绝 09 §2 列的三条破法，放行协议调用', () => {
    tester.run('no-kernel-internals', noKernelInternals, {
      valid: [
        // 正路：说协议
        { code: `await rpc.request('thread/list', { limit: 30 });` },
        // 记忆的三个协议方法名里含 "memories"/"memory"，它们是**正路**，不能被规则打掉
        { code: `await rpc.request('memories/read', {});` },
        { code: `await rpc.request('memories/write', { entry });` },
        { code: `await rpc.request('memory/reset', {});` },
        // 变量名/注释里提到这些概念不算破线（规则只看字符串与成员访问）
        { code: `const rolloutTraceEnabled = true;` },
        // 自己的投影表（09 §4.1）——名字里没有内核痕迹
        { code: `db.prepare('SELECT thread_id FROM thread_projection WHERE derived_status = ?');` },
        // 适配层可以知道 CODEX_HOME 在哪
        {
          code: `const home = process.env.CODEX_HOME;`,
          filename: '/repo/services/kernel-adapter/src/spawn.ts',
        },
        {
          code: `const home = join(base, 'kernel');`,
          filename: '/repo/services/kernel-adapter/src/spawn.ts',
        },
      ],
      invalid: [
        // ① 直接读内核 thread sqlite
        {
          code: `const rows = db.prepare('SELECT * FROM thread_store').all();`,
          errors: [{ messageId: 'kernelState' }],
        },
        // ② 直接读 rollout JSONL
        {
          code: `await readFile(\`\${home}/rollouts/\${id}.jsonl\`, 'utf8');`,
          errors: [{ messageId: 'kernelState' }],
        },
        // ③ 直接读 memories 目录（路径形态，与上面的协议方法名区分开）
        {
          code: `await readdir('/home/u/.evowork/kernel/memories');`,
          errors: [{ messageId: 'kernelState' }],
        },
        // 相对路径 + 扩展名也算路径
        {
          code: `await readFile('rollouts/2026-09-05.jsonl', 'utf8');`,
          errors: [{ messageId: 'kernelState' }],
        },
        // 表名不需要路径形态：SQL 字符串里出现即破线
        {
          code: `db.exec('ATTACH DATABASE ? AS thread_store');`,
          errors: [{ messageId: 'kernelState' }],
        },
        // CODEX_HOME 在适配层之外（成员访问写法，不含字面量）
        {
          code: `const home = process.env.CODEX_HOME;`,
          filename: '/repo/services/store/src/db.ts',
          errors: [{ messageId: 'codexHome' }],
        },
        // 链接内核 crate / SDK 内部
        {
          code: `import { Thread } from '@openai/codex-sdk';`,
          errors: [{ messageId: 'forbiddenImport' }],
        },
      ],
    });
  });
});

describe('no-style-literals（01 §9 验收项 1）', () => {
  it('拒绝颜色与 px 字面量，放行 token 与 0/1px', () => {
    tester.run('no-style-literals', noStyleLiterals, {
      valid: [
        { code: `const bg = 'var(--bg-surface)';` },
        { code: `const gap = 'var(--space-12)';` },
        // 0 与 1px 是明确的内置例外（1px 描边见 01 §4.5）
        { code: `const border = '1px solid var(--border-subtle)';` },
        { code: `const inset = '0px';` },
        // 比例值不含 px
        { code: `const w = '100%';` },
        // allow 选项
        { code: `const legacy = '13px';`, options: [{ allow: ['13px'] }] },
      ],
      invalid: [
        { code: `const c = '#6E6D68';`, errors: [{ messageId: 'color' }] },
        { code: `const c = '#fff';`, errors: [{ messageId: 'color' }] },
        {
          code: `const c = 'rgba(29,29,27,.045)';`,
          errors: [{ messageId: 'color' }],
        },
        { code: `const h = '28px';`, errors: [{ messageId: 'px' }] },
        { code: `const s = \`height: \${n}px; width: 260px;\`;`, errors: [{ messageId: 'px' }] },
        // 2px 不在例外里：01 里的 2px 聚焦环是 token，不是字面量
        { code: `const ring = '2px solid green';`, errors: [{ messageId: 'px' }] },
      ],
    });
  });
});
