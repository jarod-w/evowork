/**
 * 给**进程外驱动**用的入口：把 App 起起来，然后什么都不做。
 *
 * 断言型 E2E（`*.e2e.mjs`）是「启动 + 驱动 + 断言」三合一，跑完自己退出。
 * Playwright 要的恰好相反：它从进程外连上来点真 DOM，所以这个入口只负责把环境搭好
 * 并**活着**，一句断言都不写 —— 断言在 `ui/*.spec.mjs` 里。
 *
 * 两种驱动共用 `boot.mjs`，区别只有一个 `show` 参数。这正是拆 harness 的收益：
 * 真交互测试没有自己的一套启动代码，也就不会跟断言型 E2E 悄悄漂开。
 */
import { app } from 'electron';

import { bootApp, createE2EHome, writeKernelConfig } from './boot.mjs';
import { createFakeGateway } from './fake-gateway.mjs';
import { publishControls, waitFor } from './runner.mjs';

const repoRoot = process.env.EVOWORK_E2E_REPO_ROOT;
const appServerPath = process.env.EVOWORK_APP_SERVER;
if (!repoRoot || !appServerPath) throw new Error('UI 测试入口缺少仓库或 app-server 路径。');

/**
 * spec 与假网关之间的约定：**正文里带这段字的那个回合会被扣住不收尾**。
 *
 * 于是「一个正在运行的回合」不需要任何脚本化动作就能造出来 —— spec 只要在输入框里
 * 打出带这段字的需求，界面就会进入运行态，「停止」按钮随之出现。
 */
const TURN_MARKER = 'EVOWORK-UI-HOLD';

/**
 * 保留首次引导（`onboarding.spec.mjs` 用）。默认跳过 —— 别的旅程要测的东西在引导之后，
 * 而引导会**盖住整个界面**（`startup.onboarded` 为假时 app.tsx 直接 return 引导视图）。
 */
const KEEP_ONBOARDING = process.env.EVOWORK_UI_KEEP_ONBOARDING === '1';

const { home, workspace, kernelHome } = createE2EHome('evowork-ui-');
/*
 * **两个模型**：真交互测试里有一条要验「在界面上换一个模型，下一回合真的用它」，
 * 而一个模型的下拉框点不出任何东西来。断言型 E2E 仍然是默认的一个。
 */
const UI_MODELS = [
  { id: 'e2e-model', displayName: 'E2E Model' },
  { id: 'e2e-model-alt', displayName: 'E2E Model Alt' },
];
const gateway = createFakeGateway({ turnMarker: TURN_MARKER, models: UI_MODELS });

/*
 * **静态事实在启动之前就挂出去**，别等 `main()` 跑完。
 *
 * 否则 spec 有可能在 `publishControls` 之前就读到控制面：读出来是 `undefined`，
 * 而 `undefined` 在下游往往**不报错**（第一版就栽在这儿：`new RegExp(undefined)`
 * 是空正则，什么都匹配，于是"标记没取到"一路装成通过，直到最后一步才炸）。
 */
publishControls({
  gateway,
  workspace,
  turnMarker: TURN_MARKER,
  keptOnboarding: KEEP_ONBOARDING,
  models: UI_MODELS,
});

async function main() {
  const gatewayBaseUrl = await gateway.listen();
  writeKernelConfig(
    kernelHome,
    `model_provider = "evowork"

# 根键必须在第一个方括号表头之前（config.toml.template 同一条纪律）。
default_permissions = "evowork-workspace"
approval_policy = "never"

[model_providers.evowork]
name = "UI Gateway"
base_url = "${gatewayBaseUrl}"
wire_api = "responses"
env_key = "EVOWORK_GATEWAY_TOKEN"

[permissions.evowork-workspace]
extends = ":workspace"

[otel]
environment = "test"
exporter = "none"
`,
  );

  const desktop = await bootApp({
    repoRoot,
    appServerPath,
    home,
    hostEnv: {
      EVOWORK_GATEWAY_TOKEN: 'ui-token',
      EVOWORK_GATEWAY_URL: gatewayBaseUrl,
    },
    show: true,
    captureKernelProcess: true,
    /*
     * 假的目录选择框：系统对话框 Playwright 点不到（它不是网页的一部分），
     * 所以由主进程直接回答「用户选了这个目录」。被测的是**选完之后**的那一段
     * —— 工作空间列进来没有、「下一步」解锁没有、引导走完会不会再回来。
     */
    showOpenDialog: async () => ({ canceled: false, filePaths: [workspace] }),
  });

  /*
   * **跳过首次引导**，让第一条旅程聚焦在它要测的东西上。
   *
   * 引导会盖住整个界面（`startup.onboarded` 为假时 app.tsx 直接 return 引导视图），
   * 而断言型 E2E 从来没见过它 —— 它们只经 preload 桥说话。真窗口绕不过去。
   *
   * 走的是**公开的桥**而不是直接写 meta 表：那张表是服务层的实现细节，
   * 测试伸手进去就等于替产品决定「引导算走完了」是什么意思。
   * 写完要 reload：`startup` 是渲染层挂载时读一次的，不会自己回来看。
   */
  if (!KEEP_ONBOARDING) {
    await desktop.evaluate('window.evowork.completeOnboarding()');
    await desktop.evaluate(
      `window.evowork.createProject(${JSON.stringify({ name: 'UI', path: workspace })})`,
    );
    await desktop.window.webContents.reload();
    await waitFor(
      () => desktop.evaluate('Boolean(window.evowork)'),
      'reload 之后 preload bridge 没有回来',
    );
  }

  /*
   * 到此为止。**不退出、不断言** —— 窗口开着，Playwright 从进程外接手。
   * 进程的生命周期由 Playwright 的 `electronApp.close()` 结束。
   *
   * `ready` 是给夹具等的：窗口可见不等于准备好了（引导跳过与项目创建都在这之后），
   * 而"早一拍连上来"的表现不是报错，是读到半成品的状态。
   */
  publishControls({ ready: true });
}

main().catch((error) => {
  // 起不来时要让 Playwright 看到原因：否则那边只会报一句没用的「等窗口超时」
  console.error('[ui-entry] 启动失败：', error);
  app.exit(1);
});
