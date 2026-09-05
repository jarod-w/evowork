/**
 * 每个测试后清理 DOM。
 *
 * `@testing-library/react` 的自动清理只在 vitest 的 `globals: true` 下注册。
 * 我们用 `globals: false`（显式 import 更好读），所以必须自己接上 ——
 * 不接的后果是**测试之间互相污染**：上一条测试留下的按钮会让
 * `getByRole('button')` 报"找到多个"，而那个报错看起来像被测组件的问题。
 * 这个坑值得留一条注释，因为它的症状与原因离得很远。
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
