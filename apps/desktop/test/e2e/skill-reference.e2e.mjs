/**
 * **技能引用 · 队列 · 审批 · 断线重试 · 重试记账**：在真 Electron 窗口 + 真 `codex-app-server`
 * 上跑一遍。
 *
 * 启动那一段在 `harness/`（bootstrap 注入缝、假网关、临时 home、阶段标记），这个文件只剩
 * **驱动与断言**。分开的理由见 `harness/README.md`：两者变化的原因不同 —— 驱动随产品走，
 * 启动随内核与 Electron 走。第 2 步把驱动换成 Playwright 时只动这一侧。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { seedMemorySummary } from '../../../../services/kernel-adapter/test-support/memory-fixture.mjs';
import { bootApp, createE2EHome, writeKernelConfig } from './harness/boot.mjs';
import { createFakeGateway } from './harness/fake-gateway.mjs';
import { createRunner, publishControls, waitFor } from './harness/runner.mjs';

const { stage, report } = createRunner({
  stagePrefix: '__EVOWORK_DESKTOP_E2E_STAGE__',
  resultPrefix: '__EVOWORK_DESKTOP_E2E__',
});

stage('module-loaded');

const repoRoot = process.env.EVOWORK_E2E_REPO_ROOT;
const appServerPath = process.env.EVOWORK_APP_SERVER;
if (!repoRoot || !appServerPath) throw new Error('桌面 E2E 缺少仓库或 app-server 路径。');

const { home, workspace, kernelHome } = createE2EHome('evowork-desktop-e2e-');

/**
 * 第一条需求里的一段字。**用它来认领"哪个请求是这个回合的"**，而不是"第一个请求"。
 *
 * 内核在一次会话里并不是只发我们这一个模型请求（prewarm、记忆提取都可能先到），
 * 于是"第一个请求"有时根本不是那个回合 —— 表现就是"记忆没注入"这种偶发失败：
 * 断言看错了请求，而被看的那个请求确实没有记忆标记。认领逻辑在假网关里。
 */
const TURN_MARKER = '创建一个测试技能';
const gateway = createFakeGateway({ turnMarker: TURN_MARKER });

let host;
/**
 * 等假网关安静下来（连续 `stableMs` 没有新请求）。
 *
 * 为什么需要它：内核在一个回合结束之后还会**继续发模型请求** —— 记忆提取、上一段没跑完的
 * 重试，都会落到同一个假网关上。不等安静就读数，读到的是"当时恰好到了几条"，
 * 断言因此时红时绿（2026-09-26 那条重试记账断言就是这么飘的）。
 */
async function quiesce(gateway, stableMs = 2_000, timeoutMs = 30_000) {
  const started = Date.now();
  let last = gateway.requestCount();
  let lastChange = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = gateway.requestCount();
    if (now !== last) {
      last = now;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= stableMs) return;
    if (Date.now() - started >= timeoutMs) {
      /*
       * **超时要响亮地失败，不能静默往下走。**
       *
       * 悄悄返回的话，后面数"这个任务打了几次"会数漏（还有在飞的请求没到），
       * 断言以一个莫名其妙的数字失败，而真正的原因一个字都不会说 ——
       * 那正是 CLAUDE.md §9.1「降级、跳过、认不出来都要如实说」要挡的东西。
       */
      throw new Error(
        `假网关 ${Math.round(timeoutMs / 1000)} 秒都没安静下来（仍在收请求），` +
          '说明还有在飞的回合 —— 此时数出来的成功次数不作数。',
      );
    }
  }
}

async function run() {
  try {
    stage('gateway-starting');
    const gatewayBaseUrl = await gateway.listen();
    // 单独成段，既清楚表达这是协议配置，也避免边界 lint 把同一模板里的 URL 误判成记忆目录。
    const memoryConfig = `[features]
memories = true

[memories]
use_memories = true
generate_memories = true
disable_on_external_context = true`;
    writeKernelConfig(
      kernelHome,
      `model_provider = "evowork"

[model_providers.evowork]
name = "E2E Gateway"
base_url = "${gatewayBaseUrl}"
wire_api = "responses"
env_key = "EVOWORK_GATEWAY_TOKEN"

[permissions.evowork-workspace]
extends = ":workspace"

default_permissions = "evowork-workspace"
approval_policy = "never"

${memoryConfig}

[otel]
environment = "test"
exporter = "none"
`,
    );

    stage('bootstrap-starting');
    const desktop = await bootApp({
      repoRoot,
      appServerPath,
      home,
      hostEnv: {
        EVOWORK_GATEWAY_TOKEN: 'e2e-token',
        EVOWORK_GATEWAY_URL: gatewayBaseUrl,
      },
      captureKernelProcess: true,
    });
    stage('bootstrap-complete');
    host = desktop.host;
    const evaluate = desktop.evaluate;
    // 假网关的剧本也在主进程里：第 2 步从进程外驱动时，要的就是这个控制面
    publishControls({ gateway });
    stage('preload-ready');
    await evaluate(`
    window.__e2eEvents = [];
    window.__e2eNotices = [];
    window.evowork.onUiEvent((event) => window.__e2eEvents.push(event));
    window.evowork.onNotice((notice) => window.__e2eNotices.push(notice));
    true;
  `);

    const initialMemory = await evaluate('window.evowork.getMemorySettings()');
    if (
      !initialMemory.enabled ||
      initialMemory.version !== 'v1' ||
      initialMemory.statusSupported ||
      !initialMemory.useMemories ||
      !initialMemory.generateMemories ||
      !initialMemory.disableOnExternalContext
    ) {
      throw new Error(`真实 app-server 没有读到默认记忆设置：${JSON.stringify(initialMemory)}`);
    }
    const disabledMemory = await evaluate(
      `window.evowork.setMemorySettings(${JSON.stringify({
        enabled: true,
        useMemories: true,
        generateMemories: false,
      })})`,
    );
    if (!disabledMemory.ok || disabledMemory.view.generateMemories) {
      throw new Error('真实 app-server 没有保存记忆生成开关。');
    }
    stage('memory-settings-verified');

    // 只在测试里写入内核 fixture；生产代码仍只经 app-server 读取和控制记忆。
    const memoryMarker = 'EVOWORK_MEMORY_P1_MARKER';
    seedMemorySummary(kernelHome, memoryMarker);

    const project = await evaluate(
      `window.evowork.createProject(${JSON.stringify({ name: 'E2E', path: workspace })})`,
    );
    stage('project-created');
    if (!project.ok || !project.projects[0]?.id) throw new Error('真实窗口没能创建测试项目。');
    const workspaceId = project.projects[0].id;
    const context = await evaluate(
      `window.evowork.getComposerContext(${JSON.stringify({ workspaceId })})`,
    );
    const skill = context.mentions.find(
      (candidate) => candidate.category === 'skill' && candidate.name === 'skill-creator',
    );
    if (!skill?.path) throw new Error('真实 app-server 没有发现随包 skill-creator。');
    stage('skill-discovered');
    const reference = { type: 'skill', name: skill.name, path: skill.path };
    const first = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '$skill-creator 创建一个测试技能',
        references: [reference],
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(() => gateway.turnClaimed(), '模型请求没有到达测试网关');
    stage('first-request-held');
    const turnBody = gateway.requestBodies.find((body) => body.includes(TURN_MARKER));
    if (!turnBody?.includes(memoryMarker)) {
      throw new Error('真实 app-server 没有把本地记忆注入新任务的模型请求。');
    }
    const enabledMemory = await evaluate(
      `window.evowork.setMemorySettings(${JSON.stringify({
        enabled: true,
        useMemories: true,
        generateMemories: true,
        currentThreadId: first.threadId,
      })})`,
    );
    if (!enabledMemory.ok || !enabledMemory.view.generateMemories) {
      throw new Error('真实 app-server 没有重新启用记忆生成。');
    }
    const taskMemoryOff = await evaluate(
      `window.evowork.setTaskMemoryMode(${JSON.stringify({ threadId: first.threadId, enabled: false })})`,
    );
    const taskMemoryOn = await evaluate(
      `window.evowork.setTaskMemoryMode(${JSON.stringify({ threadId: first.threadId, enabled: true })})`,
    );
    if (!taskMemoryOff.ok || !taskMemoryOn.ok) {
      throw new Error('真实 app-server 不支持任务级记忆开关。');
    }
    const resetMemory = await evaluate('window.evowork.resetMemories()');
    if (!resetMemory.ok) throw new Error('真实 app-server 没有清空本地记忆。');
    stage('memory-task-controls-verified');
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-started' && event.taskId === ${JSON.stringify(first.threadId)})`,
        ),
      '首个真实回合没有开始',
    );

    const second = await evaluate(
      `window.evowork.send(${JSON.stringify({
        threadId: first.threadId,
        text: '$skill-creator 排队中的原始要求',
        references: [reference],
        modelId: 'e2e-model',
        modeId: 'request-approval',
      })})`,
    );
    if (!second.queued) throw new Error('运行中的第二条输入没有进入真实内核队列。');
    stage('second-request-queued');
    const queued = await evaluate(
      `window.evowork.listQueuedInputs(${JSON.stringify({ threadId: first.threadId })})`,
    );
    if (queued.length !== 1 || queued[0].references[0]?.path !== skill.path) {
      throw new Error('真实队列没有保留精确技能引用。');
    }
    const editedText = '$skill-creator 排队要求已编辑';
    const updated = await evaluate(
      `window.evowork.updateQueuedInput(${JSON.stringify({
        threadId: first.threadId,
        id: queued[0].id,
        text: editedText,
        references: [reference],
      })})`,
    );
    if (!updated) throw new Error('真实队列编辑失败。');
    const afterEdit = await evaluate(
      `window.evowork.listQueuedInputs(${JSON.stringify({ threadId: first.threadId })})`,
    );
    if (afterEdit[0]?.text !== editedText || afterEdit[0]?.references[0]?.path !== skill.path) {
      throw new Error('队列编辑后文本或技能引用丢失。');
    }

    gateway.releaseClaimedTurn();
    stage('first-request-released');
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.filter((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(first.threadId)}).length >= 2`,
        ),
      '排队回合没有自动执行完成',
      30_000,
    );
    const beforeRestart = await evaluate(
      `window.evowork.openTask(${JSON.stringify({ threadId: first.threadId })})`,
    );
    const beforeRestartText = JSON.stringify(beforeRestart);
    if (!beforeRestartText.includes(editedText) || !beforeRestartText.includes(skill.path)) {
      throw new Error('完成后的真实任务历史没有保留编辑文本和技能引用。');
    }
    /*
     * F30 的实测面：心跳帧（上面假网关发的 `response.in_progress`）**不能**变成
     * 时间线上的条目。内核的状态枚举是 camelCase（`inProgress`），带下划线的
     * `in_progress` 只可能来自那个事件类型本身 —— 出现了就说明忽略清单不再成立，
     * 而那意味着真网关的心跳会在每个任务里刷出一串垃圾条目。
     */
    if (beforeRestartText.includes('in_progress')) {
      throw new Error('心跳帧进了时间线：F30（内核忽略 response.in_progress）已被上游推翻。');
    }
    stage('queue-history-verified');

    const crashedPid = desktop.kernelPid();
    desktop.killKernel();
    await waitFor(
      () => evaluate(`window.__e2eNotices.some((notice) => notice.kind === 'kernel-restarted')`),
      '真实 app-server 崩溃后没有自动恢复',
      30_000,
    );
    stage('kernel-restarted');
    const afterRestart = await evaluate(
      `window.evowork.openTask(${JSON.stringify({ threadId: first.threadId })})`,
    );
    const refreshedContext = await evaluate(
      `window.evowork.getComposerContext(${JSON.stringify({ workspaceId })})`,
    );
    const skillAfterRestart = refreshedContext.mentions.find(
      (candidate) => candidate.category === 'skill' && candidate.name === 'skill-creator',
    );
    if (
      !JSON.stringify(afterRestart).includes(editedText) ||
      skillAfterRestart?.path !== skill.path
    ) {
      throw new Error('内核重启后历史或技能根没有恢复。');
    }

    /*
     * ── 上游断了：内核自动重试 + 界面说出来（2026-09-26 的产品决策）──
     *
     * 这一段是**整条链路唯一能被真内核证伪的地方**：
     *   ① 我们发的 `error.code` 真的落进了内核的"可重试"分支（F32），而不是终止；
     *   ② 内核重试时发的 `error` + `willRetry` 真的一路到了渲染层（适配层刚订阅它）；
     *   ③ 重试用完之后，**网关写给用户的那句中文真的显示出来了**
     *      —— 这正是换掉 `server_is_overloaded` 的全部理由（F33）。
     * 读源码能读出前两条的形状，读不出它们串起来是否成立。
     */
    /*
     * ── 协议边界的四条链路（356a93f / 8f20cbb 只对**假内核**验过）──
     *
     * 那几处缺陷的共同点是"假内核收什么都说好"：漏一个必填字段会被真内核
     * 打回 -32600，回复形状不对则**连错都不报**，内核 `unwrap_or_else` 兜一个默认值。
     * 所以这一段全部用真 app-server 跑，而且**断言的是后果**（停下来了没有、
     * 插的话有没有进到模型请求里、答案有没有到工具），不是"发出去了没有"。
     */
    await evaluate(
      `window.__e2eApprovals = []; window.evowork.onPendingApprovals((list) => { window.__e2eApprovals = list; }); true`,
    );

    // ① 停止：`turn/interrupt` 少了 turnId 的话内核只回 -32600，按钮永远点不动
    gateway.scriptNext({ kind: 'hold' });
    const stopTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '写一份很长的报告',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-started' && event.taskId === ${JSON.stringify(stopTask.threadId)})`,
        ),
      '回合没有开始，停不了',
      20_000,
    );
    // 真内核**等到 TurnAborted 才应答**这个请求 —— 它能返回本身就是这条链路通了
    await evaluate(`window.evowork.interrupt(${JSON.stringify(stopTask.threadId)})`);
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(stopTask.threadId)} && event.status === 'interrupted')`,
        ),
      '「停止」没有真的停下这个回合',
      20_000,
    );
    gateway.releaseScriptedTurn();
    stage('interrupt-verified');

    // ② 立即插话：`turn/steer` 少了 expectedTurnId 同样是 -32600
    gateway.scriptNext({ kind: 'hold' });
    const steerTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '列个提纲',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-started' && event.taskId === ${JSON.stringify(steerTask.threadId)})`,
        ),
      '回合没有开始，插不了话',
      20_000,
    );
    const steerMarker = '插话：只要三条';
    const steerResult = await evaluate(
      `window.evowork.send(${JSON.stringify({
        threadId: steerTask.threadId,
        text: steerMarker,
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
        steer: true,
      })})`,
    );
    if (steerResult?.notes?.length) {
      // 适配层在"没有活动回合"时会改成排队并说明 —— 那说明这条链路没走成
      throw new Error(`立即插话被改成了排队：${JSON.stringify(steerResult.notes)}`);
    }
    gateway.releaseScriptedTurn();
    await waitFor(
      () => gateway.requestBodies.some((body) => body.includes(steerMarker)),
      '插话的内容没有进到模型请求里（expectedTurnId 不对时内核直接打回）',
      20_000,
    );
    stage('steer-verified');

    /*
     * ③ 命令审批：**产品里真正会弹的那张卡**。
     *
     * 8f20cbb / 356a93f 改的几处审批回复都只对假内核验过，而假内核收什么都说好 ——
     * 回复形状不对时真内核**不报错**，`unwrap_or_else` 兜一个默认值。所以这里断言的不是
     * "回复发出去了"，而是**点了允许之后那条命令真的跑了**（文件真的出现在磁盘上）。
     *
     * 触发器是确定性的：`sandbox_permissions: 'require_escalated'` 就是模型在说
     * "我要越过沙箱"，内核在 on-request 档下必须问用户（`shell_spec.rs:235-256`）。
     */
    const approvedFile = join(workspace, 'approved-by-e2e.txt');
    gateway.scriptNext({
      tool: 'exec_command',
      args: {
        cmd: `printf EVOWORK-APPROVED > ${JSON.stringify(approvedFile)}`,
        sandbox_permissions: 'require_escalated',
        justification: '端到端测试：验证审批通过后命令真的会执行',
      },
    });
    const approveTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '写一个需要我批准的文件',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () => evaluate(`window.__e2eApprovals.length > 0`),
      '需要越权的命令没有弹出审批卡（on-request 档没生效，或审批请求没到渲染层）',
      20_000,
    );
    const cardJson = await evaluate(`JSON.stringify(window.__e2eApprovals[0])`);
    const card = JSON.parse(cardJson);
    if (card.kind !== 'command' || !cardJson.includes('EVOWORK-APPROVED')) {
      // 卡片上看不到要执行什么，用户就是在盲签
      throw new Error(`审批卡没拿到命令本身：${cardJson}`);
    }
    await evaluate(
      `window.evowork.decideApproval(${JSON.stringify({ id: card.id, decision: 'accept' })})`,
    );
    /*
     * **这一行才是重点**：回复形状不对时内核会静默兜底，界面上"允许"和"拒绝"一个样。
     * 文件出现在磁盘上，才证明这次授权真的落地了。
     */
    await waitFor(
      () => existsSync(approvedFile) && readFileSync(approvedFile, 'utf8') === 'EVOWORK-APPROVED',
      '点了「允许」，命令却没有真的执行',
      20_000,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(approveTask.threadId)})`,
        ),
      '审批之后那一轮没有收尾',
      30_000,
    );
    stage('command-approval-verified');

    /*
     * ④ 文件改动审批：**另一张真正会弹的卡**，而它的清单是 8f20cbb 刚修好的。
     *
     * 内核的审批 RPC **只给 itemId、不给清单**，要从 item 流里按 id 反查；
     * 修之前卡片永远显示"将改动 0 个文件" —— 在用户面前说一句笃定的假话，
     * 而用户就是靠这句话决定点不点允许的。
     *
     * 触发器要挑对路径：`:workspace` 档**本来就允许写临时目录**，
     * 而 e2e 的工作区就在临时目录下 —— 第一次探测写到 `home` 时内核根本没问
     * （那不是越权，是许可范围内）。所以这里写到仓库根：确确实实在工作区之外。
     */
    const outsideFile = join(repoRoot, '.evowork-e2e-file-change-probe.txt');
    gateway.scriptNext({
      tool: 'exec_command',
      args: {
        cmd: [
          "apply_patch <<'PATCH'",
          '*** Begin Patch',
          `*** Add File: ${outsideFile}`,
          '+EVOWORK-PATCH',
          '*** End Patch',
          'PATCH',
        ].join('\n'),
      },
    });
    await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '改一个工作区外的文件',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () => evaluate(`window.__e2eApprovals.some((a) => a.kind === 'fileChange')`),
      '改工作区外的文件没有弹出审批卡',
      20_000,
    );
    const patchCardJson = await evaluate(
      `JSON.stringify(window.__e2eApprovals.find((a) => a.kind === 'fileChange'))`,
    );
    const patchCard = JSON.parse(patchCardJson);
    /*
     * `undefined` = 没查到，`[]` = 确实不改文件 —— 两者必须分开。
     * 这条断言挂掉的两种样子都要能看出来：清单丢了（undefined），或者又变回了"0 个文件"。
     */
    if (!Array.isArray(patchCard.changes) || patchCard.changes.length === 0) {
      throw new Error(`审批卡没有文件清单（这正是"将改动 0 个文件"那条缺陷）：${patchCardJson}`);
    }
    if (!patchCard.changes.some((c) => c.path.includes('.evowork-e2e-file-change-probe.txt'))) {
      throw new Error(`清单里不是那个文件：${patchCardJson}`);
    }
    // 工作区之外要被标出来（10 §3.3）—— 用户凭这个标记决定要不要拦
    if (!patchCard.changes.some((c) => c.outsideWorkspace === true)) {
      throw new Error(`工作区之外的改动没有被标注：${patchCardJson}`);
    }
    await evaluate(
      `window.evowork.decideApproval(${JSON.stringify({ id: patchCard.id, decision: 'decline' })})`,
    );
    // 拒绝要真的拦住：文件一个字节都不该落盘
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (existsSync(outsideFile)) {
      throw new Error('点了「拒绝」，文件还是被写出去了');
    }
    stage('file-change-approval-verified');

    /*
     * ③ 追问与权限审批：**在产品当前配置下走不到**，所以这里钉住"走不到"这件事。
     *
     * 356a93f 修的两处回复形状（追问按问题 id 归位、权限回 `{permissions, scope}`）
     * 都是对的，但它们伺候的两条链路今天都发不起来：
     *   · `request_user_input` **只在 Plan 模式可用**（`tools/src/tool_config.rs:17-26`
     *     + `config_types.rs:700`），而 EvoWork 三档模式全是 `kernelMode: 'default'`；
     *     另一条路 `default_mode_request_user_input` 是 UnderDevelopment、默认关。
     *   · `request_permissions` 工具要 `Feature::RequestPermissionsTool`
     *     （`features/src/lib.rs:1219`，UnderDevelopment、默认关），所以根本不在工具清单里。
     *
     * 断言写成"现在是走不到的"而不是跳过：哪天内核把这两个开关翻过来，
     * 或者我们加了 Plan 模式，这条会**红**，那时候才轮到去验那两张卡真的能用。
     * 跳过的写法在那一天什么都不会说。
     */
    gateway.scriptNext({
      tool: 'request_user_input',
      args: {
        questions: [
          {
            id: 'fmt',
            header: '交付格式',
            question: '这份东西要 PPT 还是文档？',
            options: [
              { label: 'PPT（推荐）', description: '适合汇报' },
              { label: '文档', description: '适合存档' },
            ],
          },
        ],
      },
    });
    const askTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '先问我一个问题再动手',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(askTask.threadId)})`,
        ),
      '追问那一轮没有跑完',
      30_000,
    );
    // 搜**所有**请求体，不是最后一个：这一段后面还有别的回合，`at(-1)` 会指到别人身上
    const toolOutput = gateway.requestBodies.some((body) =>
      body.includes('request_user_input is unavailable'),
    )
      ? 'unavailable-in-default-mode'
      : 'ran';
    if (toolOutput !== 'unavailable-in-default-mode') {
      throw new Error(
        'request_user_input 现在能跑了 —— 追问审批卡因此变成活路径，去验一遍它的 questions[] 与逐题答案（356a93f 只对假内核验过）。',
      );
    }
    const approvalsAfterAsk = await evaluate(`window.__e2eApprovals.length`);
    if (approvalsAfterAsk !== 0) {
      throw new Error('追问竟然弹出了审批卡 —— 与上面那条互相矛盾，说明判据写错了。');
    }
    // 同上：挑**带工具清单**的那个请求，不是第一个（第一个可能是 prewarm）
    const withTools = gateway.requestBodies.find((body) => body.includes('"tools"'));
    const offeredTools = JSON.parse(withTools ?? '{}').tools ?? [];
    if (offeredTools.some((tool) => tool?.name === 'request_permissions')) {
      throw new Error(
        'request_permissions 进工具清单了 —— 权限审批卡因此变成活路径，去验一遍它回的 {permissions, scope}（同上，只对假内核验过）。',
      );
    }
    stage('approval-paths-pinned');

    // 大到不会误伤，但存在 —— 目的只是让 goal 存在，好读 tokensUsed
    gateway.failNextUpstream(99);
    const beforeRetry = gateway.requestCount();
    const retryTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '断线重连自检',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-retrying' && event.taskId === ${JSON.stringify(retryTask.threadId)})`,
        ),
      '内核在重试，界面却什么都没收到（适配层没订阅 error 通知时就是这个样子）',
      20_000,
    );
    // 真的重试了：同一个回合把网关打了不止一次
    await waitFor(
      () => gateway.requestCount() >= beforeRetry + 2,
      '内核没有重试上游请求 —— error.code 大概率落到了"终止"那一支',
      20_000,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-failed' && event.taskId === ${JSON.stringify(retryTask.threadId)})`,
        ),
      '重试用完之后没有把失败告诉用户',
      30_000,
    );
    const retryAttempts = gateway.requestCount() - beforeRetry;
    /*
     * 重试要**有尽头**，但尽头不是 `stream_max_retries` 那个数。
     *
     * 2026-09-26 实测：设成 2 时一个回合打了 **5～6 次**上游（默认 5 时是 **11 次**）——
     * 内核在重试用完之后还会**切一次传输通道并把计数清零**
     * （`core/src/responses_retry.rs:95-111`），于是真实上限大约是设置值的两倍多。
     * 只读代码会以为是 1+2=3；这条断言的存在就是为了让那个误差被测出来而不是被假设掉。
     */
    if (retryAttempts < 2 || retryAttempts > 8) {
      throw new Error(`重试次数不对：一个回合打了 ${retryAttempts} 次上游（预期 2–8）。`);
    }
    const failures = await evaluate(
      `JSON.stringify(window.__e2eEvents.filter((event) => event.type === 'turn-failed'))`,
    );
    if (!failures.includes('重试多次仍未成功')) {
      throw new Error('重试用完后，网关写给用户的那句话没有到达界面（message 被内核吃掉了）。');
    }
    stage('upstream-retry-verified');

    /*
     * ⑥ **重试会不会把 token 账算乱**（2026-09-26 补）。
     *
     * 重试对用户是花钱的：每一次都把整段上下文重发一遍。所以要分清两件事 ——
     *   · **重复计**：同一次回合被记了好几遍 → 预算会提前把人拦住；
     *   · **漏计**：失败那几次完全不进账 → 预算拦不住实际已经花掉的钱（Q11 的硬预算失真）。
     * 这里让上游先失败两次再成功，然后读 goal 的 `tokensUsed`：
     * 它等于**一次**成功的用量，说明没有重复计，也说明失败那两次一个 token 都没记上。
     *
     * 后者不是实现能修的：用量只在最后一帧里，流断了就没有那一帧 —— 编一个数比不记更糟。
     */
    /*
     * 先等网关安静下来：上一段（重试耗尽）的回合可能还在重试，而 `failNextUpstream`
     * 是**全局计数**——它会被还在飞的那些请求吃掉，于是这一段的失败次数不是我以为的两次。
     */
    const accountingMarker = '重试记账自检';
    await quiesce(gateway);
    const beforeAccounting = gateway.requestCount();
    gateway.failNextUpstream(2);
    const budgetTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: accountingMarker,
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await evaluate(
      `window.evowork.setTaskGoal(${JSON.stringify({
        threadId: budgetTask.threadId,
        objective: accountingMarker,
        tokenBudget: 1_000_000,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(budgetTask.threadId)} && event.status === 'completed')`,
        ),
      '失败两次之后那一轮没有成功收尾（重试没能救回来）',
      60_000,
    );
    // `executeJavaScript` 求的是**表达式**：顶层 await 会直接报 "Script failed to execute"。
    // 这里让它拿到那个 Promise，由 Electron 侧 resolve。
    const goal = await evaluate(
      `window.evowork.getTaskGoal(${JSON.stringify({ threadId: budgetTask.threadId })})`,
    );
    const tokensUsed = goal?.tokensUsed ?? 0;
    const once = gateway.usage.input_tokens + gateway.usage.output_tokens;
    /*
     * **按"这个任务实际成功了几次"算，不是写死一次。**
     *
     * 这条断言原先写成 `< once * 2`，结果三次观测里出现过 1290 / 2580 / 3870 ——
     * 都是整数倍，说明账没算乱，是**这个 thread 上成功的模型请求不止一次**：
     * 记忆提取（`generate_memories = true`）会在回合之后再发一次，而它是异步的，
     * 落在读 goal 之前还是之后全看运气。写死一次的断言因此是偶发红。
     *
     * 所以先等安静，再数这个 thread 真正打了几次、其中几次被我们判失败 ——
     * 剩下的就是成功次数。这样它仍然守住原来那两件事：
     *   · `> once × 成功次数` = 同一次被记了两遍（**重复计**，预算会提前拦人）；
     *   · `< once × 成功次数` = 有成功的请求没进账。
     * 而"失败那几次一个 token 都没记"这条结论，正是由"成功次数 = 总次数 − 失败次数"体现的。
     */
    const attempts = gateway.requestBodies
      .slice(beforeAccounting)
      .filter((body) => body.includes(accountingMarker)).length;
    const successes = attempts - 2;
    if (successes < 1) {
      throw new Error(`这个任务只打了 ${attempts} 次上游，重试没发生，这条断言无从谈起。`);
    }
    if (tokensUsed !== once * successes) {
      throw new Error(
        `重试把 token 账算乱了：记了 ${tokensUsed}，而这个任务成功了 ${successes} 次 × ${once}` +
          `（多了 = 重复计，少了 = 有成功没进账；失败的那 2 次本来就不该进账）。`,
      );
    }
    stage(`retry-accounting-verified used=${tokensUsed} successes=${successes}`);

    report({
      ok: true,
      upstreamRetryAttempts: retryAttempts,
      threadId: first.threadId,
      skillPath: skill.path,
      queuedEditPreserved: true,
      memorySettingsVerified: true,
      memoryInjectionVerified: true,
      memoryTaskControlsVerified: true,
      recoveredAfterPid: crashedPid,
      responses: gateway.requestCount(),
    });
    await host.stop();
    await gateway.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (host) await host.stop().catch(() => undefined);
    await gateway.close();
    app.exit(1);
  }
}

// Electron 的 ready 事件要等 ESM 入口完成求值；这里不能顶层 await `run()`，
// 否则 `bootstrap()` 等 ready、ready 又等模块求值，测试会无输出地死锁。
void run();
