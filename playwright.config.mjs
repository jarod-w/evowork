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
  // 跑的时候不许 Mac 空闲睡眠 —— 睡一下，用例就以「页面被关了」的样子红掉（见文件头）
  globalSetup: './apps/desktop/test/e2e/ui/global-setup.mjs',

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

  /*
   * 两个 project：
   *   `fake` —— 默认。假网关，不需要任何密钥，`pnpm run test:ui` 跑的就是它。
   *   `real` —— 真网关 + 真厂商。**只有真模型答得出来的问题**放这里
   *             （比如「介绍一下自己」会不会说漏内核品牌）。要密钥，所以单独一条命令。
   *
   * 分开不是为了"可选"，是因为两者**能证伪的东西不一样**：假网关能把模型摆布成
   * 任何样子，真模型才会说出我们没教过它的话。
   */
  projects: [
    {
      name: 'fake',
      testIgnore: '**/*.real.spec.mjs',
    },
    {
      name: 'real',
      testMatch: '**/*.real.spec.mjs',
      use: { realModel: true },
      // 真厂商比假网关慢一个量级
      timeout: 300_000,
    },
  ],
});
