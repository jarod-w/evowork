/**
 * @evowork/eslint-plugin —— 把 CLAUDE.md 的铁律与 01 的验收项做成机器可查的规则。
 *
 * 只放**会被 deadline 压垮的约定**。纯风格问题交给 prettier，纯类型问题交给 tsc。
 */
import { noKernelInternals } from './no-kernel-internals.js';
import { noStyleLiterals } from './no-style-literals.js';

const plugin = {
  meta: { name: '@evowork/eslint-plugin', version: '0.0.0' },
  rules: {
    'no-kernel-internals': noKernelInternals,
    'no-style-literals': noStyleLiterals,
  },
};

export default plugin;
export { noKernelInternals, noStyleLiterals };
