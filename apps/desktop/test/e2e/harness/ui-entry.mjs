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
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { app } from 'electron';

import { bootApp, createE2EHome, writeKernelConfig } from './boot.mjs';
import { createFakeComputerUse, cuaScript } from './fake-computer-use.mjs';
import { createFakeGateway } from './fake-gateway.mjs';
import { startRealGateway } from './real-gateway.mjs';
import { selectRealModel } from './real-models.mjs';
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

/**
 * 用**真网关 + 真模型**跑（`EVOWORK_UI_REAL_MODEL=1`）。默认是假网关。
 *
 * 两者各有各的不可替代：假网关能把模型摆布成任何样子（挂住、断线、调某个工具），
 * 而**只有真模型答得出来的问题**只能这样问 —— 比如「介绍一下自己」会不会说漏内核品牌。
 */
const REAL_MODEL = process.env.EVOWORK_UI_REAL_MODEL === '1';

/**
 * 把这次用的模型**登记成用户的自定义模型**（`~/.evowork/models.toml`，设置页写的就是这个文件）。
 *
 * 不登记的话，宿主写给内核的模型目录（`ensureKernelModelCatalog`：内置三家 + 自定义模型）里
 * 没有这次的模型，内核对它套兜底元数据：上下文按 272k 算，**子代理也拿不到协作工具**
 * （`multi_agent_version` 只在目录里声明）—— 兄弟代理互发在 E2E 里因此测不了（2026-10-05）。
 * 默认不登记：别的旅程一直是这么跑的。
 */
const REGISTER_MODELS = process.env.EVOWORK_UI_REGISTER_MODELS === '1';

/**
 * 真模型改走**宿主自己的本机网关**（D11），不起 harness 那只：模型登记成自定义模型、
 * 密钥只在环境变量里，宿主照发货的样子拉起 `dist/gateway/main.js`。
 * 这就是用户在设置页加了一个模型之后的拓扑 —— 模型目录、网关的自定义模型注入、
 * 宿主管网关的生死，都走产品自己的那条路。
 */
const HOST_GATEWAY = REAL_MODEL && process.env.EVOWORK_UI_HOST_GATEWAY === '1';

/**
 * 用**假原生 Helper** 顶替随包的 `EvoWork Computer Use.app`（`fake-computer-use.mjs`）。
 *
 * 只有这样，电脑操控「宿主准入 → 内核 → `cua_repl` MCP → 审批卡 → 状态条 → 时间线」
 * 这条链路才能在没有签名 Helper 的机器上被真窗口走一遍。默认不顶替：发货的样子是
 * 「未验收、不能启用」，那条闸门同样要有人验。
 */
const FAKE_COMPUTER_USE = process.env.EVOWORK_UI_FAKE_COMPUTER_USE === '1';

/**
 * 真模型模式下注册的模型 —— 按**用户在设置页加自定义模型**那条路走（11 §4.1）。
 *
 * 不走内置目录，是因为目录里现在没有 DeepSeek 的条目：`known-models.ts` 里那两条
 * 都没有 `builtinId`，于是只配 `DEEPSEEK_API_KEY` 时网关会 `no_models` 拒绝启动。
 * 用哪个模型由 `EVOWORK_UI_MODEL_PRESET` 选（默认 deepseek-flash），预设与能力位在 `real-models.mjs`。
 */
const REAL_MODEL_SPEC = selectRealModel();
/** DeepSeek 沿用它的内置变量名；别的厂商用中性名，免得被网关当成 DeepSeek 的密钥 */
const REAL_KEY_ENV =
  process.env.EVOWORK_UI_KEY_ENV ??
  (REAL_MODEL_SPEC.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'EVOWORK_UI_REAL_KEY');
const REAL_CUSTOM_MODELS = [
  {
    id: REAL_MODEL_SPEC.id,
    displayName: REAL_MODEL_SPEC.displayName,
    provider: REAL_MODEL_SPEC.provider,
    upstreamModel: REAL_MODEL_SPEC.upstreamModel,
    baseUrl: REAL_MODEL_SPEC.baseUrl,
    keyEnv: REAL_KEY_ENV,
    capabilities: REAL_MODEL_SPEC.capabilities,
  },
];

const { home, workspace, kernelHome } = createE2EHome('evowork-ui-');
// A fresh SQLite home also needs a fresh Chromium profile; drafts persist in localStorage.
app.setPath('userData', home);
/*
 * **两个模型**：真交互测试里有一条要验「在界面上换一个模型，下一回合真的用它」，
 * 而一个模型的下拉框点不出任何东西来。断言型 E2E 仍然是默认的一个。
 */
const UI_MODELS = [
  {
    id: 'e2e-model',
    displayName: 'E2E Model',
    imageInput: process.env.EVOWORK_UI_IMAGE_INPUT === '1',
  },
  {
    id: 'e2e-model-alt',
    displayName: 'E2E Model Alt',
    imageInput: process.env.EVOWORK_UI_IMAGE_INPUT === '1',
  },
];
const gateway = REAL_MODEL
  ? null
  : createFakeGateway({ turnMarker: TURN_MARKER, models: UI_MODELS });
const computerUse = FAKE_COMPUTER_USE ? createFakeComputerUse() : null;

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
  ...(computerUse ? { computerUse: { ...computerUse, script: cuaScript } } : {}),
});

/** 一个空闲的本机端口。宿主网关监听 `base_url` 里的端口，不能撞上开发机上常驻的 8787 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** `models.toml` 的条目（= `CustomModelSpec`）。假网关的模型照它目录里的能力位写 */
function customModelRecords(gatewayBaseUrl) {
  if (REAL_MODEL) return REAL_CUSTOM_MODELS;
  return UI_MODELS.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: 'private',
    upstreamModel: model.id,
    baseUrl: gatewayBaseUrl,
    // 假网关不收密钥；宿主读文件时只要求它非空。宿主不拉起网关，这个变量也就没人读
    keyEnv: 'EVOWORK_UI_FAKE_KEY',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: false,
      promptCache: false,
      imageInput: model.imageInput,
      maxContextTokens: 32_000,
    },
  }));
}

/**
 * 写 `models.toml`，格式照设置页的 `serializeModelsToml`（`custom-models.ts`）。
 *
 * 不 import 它：那个模块经 `@evowork/gateway` 指到 TS 源码，Electron 主进程加载不了，
 * 2026-10-05 第一次就这么在用户屏幕上弹了一个主进程异常框。抄一份格式的代价是可能漂开 ——
 * 所以启动之后由 `assertRegistered` 核对宿主**真的读懂了**（模型进了它写给内核的目录）。
 */
function writeCustomModels(records) {
  const lines = [];
  for (const model of records) {
    lines.push(
      '[[models]]',
      `id = "${model.id}"`,
      `display_name = "${model.displayName}"`,
      `provider = "${model.provider}"`,
      `upstream_model = "${model.upstreamModel}"`,
      `base_url = "${model.baseUrl}"`,
      `key_env = "${model.keyEnv}"`,
      `reasoning = ${String(model.capabilities.reasoning)}`,
      `image_input = ${String(model.capabilities.imageInput)}`,
      `parallel_tool_calls = ${String(model.capabilities.parallelToolCalls)}`,
      `prompt_cache = ${String(model.capabilities.promptCache)}`,
      `max_context_tokens = ${String(model.capabilities.maxContextTokens)}`,
      '',
    );
  }
  writeFileSync(join(home, '.evowork', 'models.toml'), lines.join('\n'), { mode: 0o600 });
}

/** 登记的模型必须出现在宿主写给内核的目录里，否则登记等于没做，而用例会以别的样子红 */
function assertRegistered(records) {
  let slugs = [];
  try {
    const catalog = JSON.parse(readFileSync(join(kernelHome, 'model-catalog.json'), 'utf8'));
    slugs = catalog.models.map((model) => model.slug);
  } catch {
    /* 读不到就按「一个都没进」报 */
  }
  const missing = records.map((model) => model.id).filter((id) => !slugs.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `登记的模型没进宿主写给内核的模型目录：${missing.join(', ')}。` +
        'models.toml 的格式可能已和设置页的 serializeModelsToml 漂开。',
    );
  }
}

async function main() {
  const real =
    REAL_MODEL && !HOST_GATEWAY
      ? await startRealGateway({
          repoRoot,
          keyEnvName: REAL_KEY_ENV,
          apiKey: process.env.EVOWORK_UI_MODEL_KEY,
          customModels: REAL_CUSTOM_MODELS,
          logFile: join(home, 'gateway.log'),
        })
      : null;
  if (real) {
    /*
     * 真网关是**子进程**，不会随 App 一起退出：Playwright 关掉 App 之后它就成了孤儿，
     * 每跑一次 real 就在 Dock 上多一个图标（2026-09-27 攒到三个才被发现）。
     * 假网关没有这个问题 —— 它是这个进程里的一个 http server。
     */
    app.on('will-quit', () => real.stop());
    publishControls({ gatewayPid: real.pid });
  }
  const gatewayBaseUrl = HOST_GATEWAY
    ? `http://127.0.0.1:${await freePort()}/v1`
    : real
      ? real.baseUrl
      : await gateway.listen();
  const gatewayToken = HOST_GATEWAY
    ? randomBytes(24).toString('base64url')
    : real
      ? real.token
      : 'ui-token';
  // 宿主启动时读 models.toml 写模型目录，所以要在 bootApp 之前落盘
  const registered = REGISTER_MODELS || HOST_GATEWAY ? customModelRecords(gatewayBaseUrl) : [];
  if (registered.length > 0) writeCustomModels(registered);
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
# UI 测试里不要退避重试：一次失败要等好几轮退避，实测把一条用例拖到 11 分钟。
# 重试本身另有专门的断言（断言型 E2E 的 upstream-retry），这里要的是"失败之后界面长什么样"。
stream_max_retries = 0

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
      EVOWORK_GATEWAY_TOKEN: gatewayToken,
      /*
       * 宿主网关模式下**不设** `EVOWORK_GATEWAY_URL`：设了它，宿主就当网关在别处，
       * 不再从内核配置里认自己的本机网关。密钥按设置页的变量名给，宿主转交给网关子进程。
       */
      ...(HOST_GATEWAY
        ? { [REAL_KEY_ENV]: process.env.EVOWORK_UI_MODEL_KEY }
        : { EVOWORK_GATEWAY_URL: gatewayBaseUrl }),
    },
    ...(HOST_GATEWAY ? { gatewayEntryPath: join(repoRoot, 'dist/gateway/main.js') } : {}),
    ...(computerUse ? { computerUse: { helper: computerUse.helper, releaseVerified: true } } : {}),
    show: true,
    captureKernelProcess: true,
    /*
     * 假的目录选择框：系统对话框 Playwright 点不到（它不是网页的一部分），
     * 所以由主进程直接回答「用户选了这个目录」。被测的是**选完之后**的那一段
     * —— 工作空间列进来没有、「下一步」解锁没有、引导走完会不会再回来。
     */
    /*
     * 同一个对话框还有第二种问法：Composer 的「添加本地文件」（`openFile + multiSelections`）。
     * 用户在那里多选了哪些文件，由 spec 事先写进 `__evoworkE2E.pickedFiles`。
     * 按问法分开答，是因为答错的表现不报错：把工作空间目录当成一个"文件"交回去，
     * 附件条上只会多一个读不到的条目。没设就当用户点了取消。
     */
    showOpenDialog: async (options) => {
      if (!options?.properties?.includes('multiSelections')) {
        return { canceled: false, filePaths: [workspace] };
      }
      const picked = globalThis.__evoworkE2E?.pickedFiles ?? [];
      return { canceled: picked.length === 0, filePaths: picked };
    },
  });

  if (registered.length > 0) assertRegistered(registered);

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
