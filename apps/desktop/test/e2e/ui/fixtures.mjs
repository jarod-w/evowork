/**
 * UI 测试的夹具：拉起真 App，交出一个能点的 `page`。
 *
 * 启动细节全在 `harness/ui-entry.mjs` 里（它跑在 Electron 主进程），这边只负责
 * 从**进程外**连上去。两侧的分工就是第 1 步拆出来的那条线。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';

import { _electron as electron, expect, test as base } from '@playwright/test';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '../../../../..');

const platformKey =
  platform() === 'darwin'
    ? `mac-${arch()}`
    : platform() === 'win32'
      ? `win-${arch()}`
      : `linux-${arch()}`;

const KERNEL =
  process.env.EVOWORK_APP_SERVER ??
  resolve(
    ROOT,
    'build/kernel',
    platformKey,
    platform() === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
  );

/** 真模型模式要密钥。缺了就当场停下 —— 而不是跳过，跳过会被当成"验过了"。 */
function requireKey() {
  const key = process.env.EVOWORK_UI_MODEL_KEY;
  if (!key) {
    throw new Error(
      '真模型 UI 测试需要 EVOWORK_UI_MODEL_KEY（厂商密钥）。\n' +
        '例：EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:ui-real',
    );
  }
  return key;
}

export const test = base.extend({
  /**
   * 保留首次引导。用 `test.use({ keepOnboarding: true })` 打开。
   * 默认跳过：别的旅程要测的东西都在引导之后，而引导会盖住整个界面。
   */
  keepOnboarding: [false, { option: true }],

  /**
   * 用真网关 + 真厂商跑。由 `playwright.config.mjs` 的 `real` project 打开。
   *
   * **没有密钥就报错，不跳过** —— 跳过的测试会让人以为验过了（CLAUDE.md §9.1）。
   * 密钥只经环境变量传进子进程：不写盘、不进日志、不提交。
   */
  realModel: [false, { option: true }],

  electronApp: async ({ keepOnboarding, realModel }, use) => {
    if (!existsSync(KERNEL)) {
      // 不跳过：缺内核就是没验证，而"跳过的测试"会让人以为验过了（CLAUDE.md §9.1）
      throw new Error(`找不到真实 app-server：${KERNEL}。先构建或设置 EVOWORK_APP_SERVER。`);
    }

    /*
     * `ELECTRON_RUN_AS_NODE` 必须摘掉 —— 与两个 runner 脚本同一个理由：
     * VS Code 的终端与扩展宿主会设它，继承下去 Electron 就以普通 Node 启动，
     * 入口第一行 import 直接报 "does not provide an export named 'app'"。
     */
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;

    const app = await electron.launch({
      executablePath: require('electron'),
      args: [resolve(ROOT, 'apps/desktop/test/e2e/harness/ui-entry.mjs')],
      cwd: ROOT,
      env: {
        ...parentEnv,
        EVOWORK_E2E_REPO_ROOT: ROOT,
        EVOWORK_APP_SERVER: KERNEL,
        ...(keepOnboarding ? { EVOWORK_UI_KEEP_ONBOARDING: '1' } : {}),
        ...(realModel ? { EVOWORK_UI_REAL_MODEL: '1', EVOWORK_UI_MODEL_KEY: requireKey() } : {}),
      },
      timeout: 120_000,
    });
    await use(app);
    await app.close();
  },

  page: async ({ electronApp, keepOnboarding }, use) => {
    const page = await electronApp.firstWindow();
    /*
     * 先等入口把话说完（引导跳过、项目建好、控制面挂齐），再去碰界面。
     * 少了这一步，spec 读控制面会读到 `undefined` —— 而那不报错，只是让断言失去意义。
     */
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E?.ready === true), {
        timeout: 120_000,
      })
      .toBe(true);
    /*
     * 等输入框可见，而不是等 `domcontentloaded`：入口在引导走完之后会 **reload**
     * 一次，太早拿到的 page 正对着一个马上要被替换掉的文档。
     * 输入框出现 = 引导过了、项目建好了、工作台真的渲染出来了。
     */
    /*
     * 等的东西按模式分：引导模式下界面上根本没有输入框（引导盖住了整个界面），
     * 等它只会以一句「超时」告终，而真正的原因是"等错了东西"。
     */
    const ready = keepOnboarding
      ? page.getByRole('heading', { name: '欢迎使用 EvoWork' })
      : page.getByLabel('需求输入');
    await ready.waitFor({ state: 'visible', timeout: 120_000 });
    await use(page);
  },
});

export { expect } from '@playwright/test';
