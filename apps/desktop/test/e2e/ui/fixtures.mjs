/**
 * UI 测试的夹具：拉起真 App，交出一个能点的 `page`。
 *
 * 启动细节全在 `harness/ui-entry.mjs` 里（它跑在 Electron 主进程），这边只负责
 * 从**进程外**连上去。两侧的分工就是第 1 步拆出来的那条线。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test as base } from '@playwright/test';

import { kernelProvenanceProblem } from '../../../../../scripts/kernel-provenance.mjs';
import { removeE2EHome } from '../harness/runner.mjs';

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

/** 内核要是发货的那个（build-kernel + 当前补丁）。哈希上百 MB 的二进制，每个 worker 只做一次。 */
let kernelProblem;
function kernelProvenance() {
  kernelProblem ??= kernelProvenanceProblem(KERNEL, ROOT) ?? '';
  return kernelProblem;
}

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

/** 进程还在不在。`kill(pid, 0)` 只探测、不发信号 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 等真网关退出；两秒后还在就杀掉它，并返回 true（= 它泄漏了）。
 * 给它一点时间，是因为 will-quit 里发的 SIGTERM 要等它自己收尾。
 */
async function reapGateway(pid) {
  if (typeof pid !== 'number') return false;
  for (let waited = 0; waited < 2_000; waited += 100) {
    if (!alive(pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill(pid, 'SIGKILL');
  return true;
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

  electronApp: async ({ keepOnboarding, realModel }, use, testInfo) => {
    if (!existsSync(KERNEL)) {
      // 不跳过：缺内核就是没验证，而"跳过的测试"会让人以为验过了（CLAUDE.md §9.1）
      throw new Error(`找不到真实 app-server：${KERNEL}。先构建或设置 EVOWORK_APP_SERVER。`);
    }
    // 没打补丁的内核照样能跑，只是少了那几项修复 —— 在它上面判出来的红绿不代表发货的内核
    if (kernelProvenance()) throw new Error(kernelProvenance());

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
    /*
     * 主进程的输出与退出方式落进这个用例的输出目录。
     * 2026-09-29/30 的真模型轮次里 App 三次在用例中途**自己关掉了**（Target page … has been closed），
     * 与测试方 A4 #0 的 TargetClosedError 同一个样子 —— 而主进程的日志当时只在内存里，
     * 进程一退就什么都不剩。退出码 / 信号能分出是崩了、被杀了还是自己 quit 了。
     */
    const mainLog = testInfo.outputPath('electron-main.log');
    const keep = (chunk) => {
      try {
        appendFileSync(mainLog, chunk);
      } catch {
        /* 诊断用的副本写不进去不影响测试 */
      }
    };
    app.process().stdout?.on('data', keep);
    app.process().stderr?.on('data', keep);
    app
      .process()
      .on('exit', (code, signal) =>
        keep(
          `\n[fixtures] 主进程退出 code=${code} signal=${signal} at ${new Date().toISOString()}\n`,
        ),
      );
    await use(app);

    /*
     * 路径要在**测试跑完之后、关闭之前**取：太早的话 `bootApp` 还没发布控制面，
     * 拿到的是 undefined；太晚的话进程没了，问不出来。
     */
    const home = await app.evaluate(() => globalThis.__evoworkE2E?.home).catch(() => undefined);
    const gatewayPid = await app
      .evaluate(() => globalThis.__evoworkE2E?.gatewayPid)
      .catch(() => undefined);
    await app.close();
    const leaked = await reapGateway(gatewayPid);

    /*
     * **通过才清理，失败留着现场。**
     * 不清理的代价实测过：一次会话在 `/var/folders` 下攒了 4.8 GB，
     * 而那个目录没人会去看。失败时留着，是因为那份 home 里有 sqlite 与内核家目录 ——
     * 排查"为什么这条红了"只能靠它。
     */
    if (testInfo.status === testInfo.expectedStatus) removeE2EHome(home);
    /*
     * 关 App 之后网关还活着 = 泄漏。已经替它收了尸，但**仍然判红**：
     * 只默默杀掉的话，`ui-entry.mjs` 那条 will-quit 哪天断了也没人知道 ——
     * 上一次就是这样，孤儿进程在 Dock 上攒到三个才被人看见。
     */
    if (leaked) {
      throw new Error(`关掉 App 之后真网关（pid ${gatewayPid}）还活着：它没有随 App 退出。`);
    }
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

/**
 * 生成多附件旅程的输入（`harness/make-office-fixtures.py`）：两张图的 docx、两张图的 pptx、
 * xlsx、csv、png，每个文件藏一个只有它才有的事实。
 *
 * 要**办公扩展的 python**（它带着 python-docx / python-pptx / matplotlib 和中文字体）。
 * 没装就报错而不是跳过 —— 同一个解释器也是 App 解析 docx / pptx 用的那个，
 * 没有它，这条旅程能验的只剩 csv。
 */
export function makeOfficeFixtures(dir) {
  const python =
    process.env.EVOWORK_OFFICE_PYTHON ?? join(homedir(), '.evowork/runtime/office/bin/python3');
  if (!existsSync(python)) {
    throw new Error(
      `找不到办公扩展的 python：${python}。先在 App 里安装办公扩展，或设 EVOWORK_OFFICE_PYTHON。`,
    );
  }
  mkdirSync(dir, { recursive: true });
  execFileSync(python, [
    resolve(ROOT, 'apps/desktop/test/e2e/harness/make-office-fixtures.py'),
    dir,
  ]);
  return OFFICE_FIXTURES.map((fixture) => ({ ...fixture, path: join(dir, fixture.file) }));
}

/** 每个文件里只有它才有的那个事实（与 make-office-fixtures.py 的文件头一致） */
export const OFFICE_FIXTURES = Object.freeze([
  {
    file: '上半年销售报告.docx',
    embeddedImages: 2,
    needle: /915/,
    what: 'docx 正文里的累计销售额',
  },
  {
    file: 'Q3市场计划.pptx',
    embeddedImages: 2,
    needle: /45\s*%/,
    what: 'pptx 饼图里的企业客户占比（只在图的像素里）',
  },
  { file: '市场预算.xlsx', embeddedImages: 0, needle: /80/, what: 'xlsx 预算合计' },
  {
    file: '渠道名单.csv',
    embeddedImages: 0,
    needle: /星河科技[\s\S]*云帆数据|云帆数据[\s\S]*星河科技/,
    what: 'csv 渠道名',
  },
  { file: '走势图.png', embeddedImages: 0, needle: /成本/, what: 'png 图例' },
]);
