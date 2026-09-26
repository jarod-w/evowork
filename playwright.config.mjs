import { defineConfig } from '@playwright/test';

/**
 * 真窗口 UI 测试（第 2 步）。**与 `pnpm run check` 分开**，用 `pnpm run test:ui` 跑。
 *
 * 不进 check 的理由：它要一个真的 `codex-app-server` 二进制和一个能开窗口的桌面会话，
 * 而 check 是每次改代码都要跑的门 —— 把一个依赖外部产物的测试塞进去，
 * 结果一定是大家习惯性地跳过它，那比不加更糟。
 */
export default defineConfig({
  testDir: './apps/desktop/test/e2e/ui',
  testMatch: '**/*.spec.mjs',

  /*
   * 一次只起一个：每个用例都拉起一个真 Electron + 一个真内核子进程，
   * 它们抢同一个 app-server 二进制、同一批本机端口，并行只会互相打架。
   */
  workers: 1,
  fullyParallel: false,

  // 真内核冷启动 + 首个回合往返，20 秒的默认断言超时太紧
  timeout: 180_000,
  expect: { timeout: 20_000 },

  reporter: [['list']],
});
