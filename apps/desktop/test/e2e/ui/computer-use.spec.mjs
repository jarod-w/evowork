/**
 * **电脑操控（12）的真窗口旅程**：设置页启停 · 内容传输告知 · 应用准入 · 硬禁止 ·
 * 写动作审批 · 「正在使用」状态条与停止控制 · 时间线里的留存内容 · 撤销授权。
 *
 * 两种起法：
 * - **发货的样子**（默认夹具）：随包 Helper 没有验收标记，`releaseVerified=false`。
 *   这条闸门（12 §17「发布闸门」）此前只有宿主单测守着 —— 设置页、内核配置、
 *   模型拿到的工具清单三处是不是都真的关着，没有人在真窗口里看过。
 * - **假原生 Helper**（`fakeComputerUse`，见 `harness/fake-computer-use.mjs`）：
 *   宿主 → 内核 → `cua_repl` MCP → 认证 socket → 准入/审批 → 界面，除 Helper 进程外全是真的。
 *   **这些绿不证明原生能力**（AX、截图、TCC、签名、物理输入中断都不经过它，CU-R1/R4/R11）。
 *
 * 剧本由假网关按**这一回合已发生几次工具调用**认领（`scriptComputerUse`）：
 * 模型每调一次工具，下一次请求的历史就多一条 function_call，计数即步号。
 * 这里不判模型会不会用这套工具 —— 那是 `computer-use.real.spec.mjs` 的事。
 */
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

import {
  BODY_ELEMENT,
  SYSTEM_SETTINGS,
  TERMINAL,
  TEXTEDIT,
  backToComposer,
  cuaConfigSection,
  e2eHome,
  enableComputerUse,
  expandComputerUseItems,
  fakeDocument,
  helperCalls,
  openComputerUseSettings,
  send,
} from './computer-use.mjs';
import { expect, test } from './fixtures.mjs';

test.skip(
  platform() !== 'darwin',
  '电脑操控首版只支持 macOS 14.4+（CU-Q1=A），其它平台宿主直接报「不支持」',
);

/** 模型请求里声明了电脑操控工具的样子（闸门那条判「没有」，链路那条判「有」—— 同一个查法两头都用） */
const CUA_TOOLS_OFFERED = /cua_repl|"name":"get_app_state"/;

function newMarker(name) {
  return `CUA-${name}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/**
 * 给这一回合写剧本：第 k 步 = 历史里已有 k 次工具调用的那次请求。
 * `{ tool, args, withState }` 调一个 `cua_repl` 工具（`withState` 带上最近一次读到的 `state_id`）；
 * `{ text }` 收尾；`gate` 给了就等控制面上那个标志为真再答（最多 30 秒，见假网关的 `untilReady`）。
 */
async function scriptComputerUse(electronApp, marker, steps) {
  await electronApp.evaluate(
    (_electron, { marker, steps }) => {
      const { gateway, computerUse } = globalThis.__evoworkE2E;
      const cua = computerUse.script;
      steps.forEach((step, index) => {
        gateway.scriptWhen(
          `${marker}#${index}`,
          (view) =>
            view.text.includes(marker) && cua.offered(view.text) && view.calls.length === index,
          step.text !== undefined
            ? { kind: 'text', text: step.text }
            : {
                tool: (body) => cua.declared(body, step.tool) ?? step.tool,
                args: (body) => ({
                  ...step.args,
                  ...(step.withState ? { state_id: cua.latestStateId(body) } : {}),
                }),
              },
          step.gate ? { ready: () => globalThis.__evoworkE2E[step.gate] === true } : {},
        );
      });
    },
    { marker, steps },
  );
}

/** 第 k 步认领到的那条请求正文（= 模型在那一步看到了什么） */
async function stepBody(electronApp, marker, index) {
  const read = () =>
    electronApp.evaluate(
      (_electron, name) => globalThis.__evoworkE2E.gateway.matchedBody(name),
      `${marker}#${index}`,
    );
  await expect.poll(read, { timeout: 90_000, message: `第 ${index} 步的请求没有到` }).toBeTruthy();
  return read();
}

test.describe('发货的样子：未验收的构建', () => {
  test('设置页、内核配置、模型的工具清单三处都关着', async ({ page, electronApp }) => {
    const section = await openComputerUseSettings(page);

    // ① 如实说为什么不能用，按钮点不动（12 §17：不能把「未验证」变成「就绪」）
    await expect(section.getByRole('status')).toHaveText(
      '此构建尚未完成原生签名、历史删除与用户中断验收，暂不能启用。',
    );
    await expect(section.getByRole('button', { name: '启用电脑操控' })).toBeDisabled();
    await expect(section.getByRole('button', { name: '停止控制' })).toHaveCount(0);

    // ② 内核里登记了 cua_repl，但它是关着的；令牌只登记变量名，值不落进配置文件
    const config = await cuaConfigSection(electronApp);
    expect(config, '宿主没有把 cua_repl 写进内核配置').toBeTruthy();
    expect(config).toMatch(/^enabled = false$/m);
    expect(config).toContain('env_vars = ["EVOWORK_CUA_SOCKET", "EVOWORK_CUA_SESSION_TOKEN"]');
    expect(config).not.toMatch(/EVOWORK_CUA_SESSION_TOKEN\s*=/);

    /*
     * ③ **模型手里没有任何电脑操控工具。** 这是闸门真正的后果：
     * 设置页关着而内核照样把工具声明给模型，用户看到的「不能启用」就是一句空话。
     */
    await backToComposer(page);
    const ask = `用电脑操控在 TextEdit 里写一行字 ${newMarker('GATE')}`;
    await send(page, ask);
    const turnBodies = () =>
      electronApp.evaluate(
        (_electron, text) =>
          globalThis.__evoworkE2E.gateway.requestBodies.filter(
            (body) => body.includes(text) && body.includes('"tools"'),
          ),
        ask,
      );
    await expect
      .poll(async () => (await turnBodies()).length, {
        timeout: 90_000,
        message: '这一回合的模型请求没有到假网关',
      })
      .toBeGreaterThan(0);
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 90_000,
    });
    for (const body of await turnBodies()) {
      expect(body, '闸门关着，模型却拿到了 cua_repl 的工具').not.toMatch(CUA_TOOLS_OFFERED);
    }
  });
});

test.describe('假原生 Helper：宿主到界面的整条链路', () => {
  test.use({ fakeComputerUse: true });

  /** 开任务，一路点到 TextEdit 准入给出、第一次读取完成（= 剧本第 0–2 步） */
  async function grantTextEdit(page, scope = '仅本次任务') {
    const card = page.getByLabel('需要你回答');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.getByRole('button', { name: '继续并启用' }).click();
    await expect(card).toContainText('允许 EvoWork 读取并操作 TextEdit？');
    await card.getByRole('button', { name: scope }).click();
    // 等准入卡真的走掉：紧接着可能来的是写动作的卡，同一个定位器会先撞上旧的这张
    await expect(
      page.getByRole('alertdialog').filter({ hasText: '读取并操作 TextEdit' }),
    ).toHaveCount(0);
  }

  /** 写动作的结局：值落到了应用上，还是先弹出一张卡（交回卡片文字） */
  async function writeOutcome(page, electronApp, value) {
    let outcome;
    await expect
      .poll(
        async () => {
          if ((await fakeDocument(electronApp)).body === value) outcome = { landed: true };
          else if ((await page.getByRole('alertdialog').count()) > 0)
            outcome = { card: (await page.getByRole('alertdialog').first().innerText()).trim() };
          return outcome !== undefined;
        },
        { timeout: 60_000, message: '写动作既没落到应用上，也没弹卡' },
      )
      .toBe(true);
    return outcome;
  }

  test('告知 → 硬禁止 → 准入 → 状态条 → 停止控制 → 留存内容', async ({ page, electronApp }) => {
    await enableComputerUse(page, electronApp);
    const canary = await electronApp.evaluate(() => globalThis.__evoworkE2E.computerUse.canary);
    const marker = newMarker('CHAIN');

    await scriptComputerUse(electronApp, marker, [
      /* 0 */ { tool: 'list_apps', args: {} },
      /* 1 */ { tool: 'get_app_state', args: { app: TERMINAL } },
      /* 2 */ { tool: 'get_app_state', args: { app: TEXTEDIT } },
      /* 3 */ { tool: 'get_app_state', args: { app: TEXTEDIT }, gate: 'cuaStopClicked' },
      /* 4 */ { text: '电脑操控已被你停止，我不再继续操作。' },
    ]);
    await send(page, `看看 TextEdit 里写了什么 ${marker}`);

    // 闸门那条「模型拿不到工具」的正向对照：开着的时候，同一种查法确实查得到
    expect(await stepBody(electronApp, marker, 0)).toMatch(CUA_TOOLS_OFFERED);

    /*
     * ① **先告知、后读取**（12 §0 / CU-Q5）。卡片要说清发给哪个模型、留在本机任务历史、
     * 删本机任务撤不回模型提供方已收到的数据 —— 而这一刻 Helper 一个应用都还没被问过。
     */
    const card = page.getByLabel('需要你回答');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText('界面文字和必要截图会发送给模型');
    await expect(card).toContainText('保存在此任务本机历史中');
    await expect(card).toContainText('删除本机任务不能撤回模型提供方已收到的数据');
    expect(
      (await helperCalls(electronApp)).map((call) => call.method),
      '用户还没同意，Helper 就被问了',
    ).toEqual(['health']);
    await card.getByRole('button', { name: '继续并启用' }).click();

    /*
     * ② 硬禁止的应用**不出现在可选列表里**（CU-Q6）：模型看到的 list_apps 结果
     * 只有 TextEdit。终端和系统设置是假 Helper 列出来的 —— 真 Helper 也会看见它们。
     */
    const afterList = await stepBody(electronApp, marker, 1);
    expect(afterList).toContain(TEXTEDIT);
    expect(afterList, '终端出现在了模型可选的应用里').not.toContain(TERMINAL);
    expect(afterList, '系统设置出现在了模型可选的应用里').not.toContain(SYSTEM_SETTINGS);

    /*
     * ③ 点名要终端：**在读取之前**拒绝，不弹准入卡（「始终允许」都覆盖不了，更不该问）。
     * 证据是 Helper 的调用记录 —— 假 Helper 被问到终端时照样会答，漏放会留下痕迹。
     */
    const afterTerminal = await stepBody(electronApp, marker, 2);
    expect(afterTerminal).toContain('POLICY_DENIED');

    // ④ 应用准入：三个范围都在，文案说清准入不等于放行动作
    await expect(card).toBeVisible();
    await expect(card).toContainText(
      '允许 EvoWork 读取并操作 TextEdit？应用准入不会跳过动作审批。',
    );
    for (const name of ['仅本次任务', '始终允许此应用', '不允许']) {
      await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await card.getByRole('button', { name: '仅本次任务' }).click();

    // ⑤ 读到的界面交给了模型（CU-D7：这是设计内的数据去向）
    expect(await stepBody(electronApp, marker, 3)).toContain(canary);

    /*
     * ⑥ 「正在使用」状态条：要有文字（10.3：不能只靠颜色），点「停止控制」它就消失。
     * 剧本第 3 步在等这一下，等到之后模型再去读 —— 那次读取必须被挡下。
     */
    // 待确认吸顶条也是 `.ew-approval-bar[role=status]`（「有 N 项待你确认」），按文字认这一条
    const bar = page.locator('.ew-approval-bar[role="status"]').filter({ hasText: '正在使用' });
    await expect(bar).toContainText('EvoWork 正在使用 TextEdit');
    await bar.getByRole('button', { name: '停止控制' }).click();
    await expect(bar).toHaveCount(0);
    const readsBeforeStop = (await helperCalls(electronApp)).filter(
      (call) => call.method === 'get_app_state',
    ).length;
    await electronApp.evaluate(() => {
      globalThis.__evoworkE2E.cuaStopClicked = true;
    });

    expect(
      await stepBody(electronApp, marker, 4),
      '停止之后的那次读取没有以 USER_STOPPED 收场',
    ).toContain('USER_STOPPED');
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 60_000,
    });
    const calls = await helperCalls(electronApp);
    expect(
      calls.filter((call) => call.method === 'get_app_state').length,
      '点了停止控制，Helper 还在被读取',
    ).toBe(readsBeforeStop);
    expect(
      calls.filter((call) => call.app === TERMINAL || call.app === SYSTEM_SETTINGS),
      '硬禁止的应用被交给了 Helper',
    ).toEqual([]);

    /*
     * ⑦ 时间线：读取项说明内容已保存在任务里，**正文默认不显示**（CU-R9），
     * 用户主动点「查看保存内容」才露出来，再点就收起。
     */
    await expandComputerUseItems(page);
    await expect(page.getByText(canary)).toHaveCount(0);
    const read = page
      .locator('.ew-computer-use-record')
      .filter({ hasText: '读取的界面内容已保存到此任务' })
      .first();
    await expect(read).toBeVisible();
    await read.getByRole('button', { name: '查看保存内容' }).click();
    await expect(read).toContainText(canary);
    await read.getByRole('button', { name: '隐藏保存内容' }).click();
    await expect(page.getByText(canary)).toHaveCount(0);

    /*
     * ⑧ 结构化审计记了结果码，**没有界面正文**（12 §8.2 / CU-D9）。
     * 走公开的桥读，和「用量与审计」页看到的是同一份。
     */
    const audit = await page.evaluate(() => window.evowork.getAudit());
    const auditText = JSON.stringify(audit);
    expect(
      audit.records.some((record) => record.toolName === 'get_app_state'),
      '电脑操控的调用没有进审计',
    ).toBe(true);
    expect(auditText).toContain('POLICY_DENIED');
    // 用户点了停止、以及停止后被挡下的那次读取都要留痕（12 §8.2 的 computer_use.user_stopped）
    expect(auditText, '停止控制没有进审计').toContain('stop_control');
    expect(auditText).toContain('USER_STOPPED');
    expect(auditText, '界面正文进了审计').not.toContain(canary);

    // ⑨「仅本次任务」不留持久授权；设置页如实说控制已停止
    const section = await openComputerUseSettings(page);
    await expect(section).not.toContainText(TEXTEDIT);
    await expect(section.getByRole('status')).toHaveText('控制已停止；需要重新发起回合才能继续。');
  });

  /*
   * 12 §7.3：「请求批准」档下**每个写动作都要再批一次** —— 应用准入刚给过也一样（§7.2 卡上那句
   * 「应用准入不会跳过动作审批」）。批了才落到应用上，落上之后重新读能读到。
   *
   * 2026-10-05 首次跑红在第 ① 步，已修：内核的 MCP 工具审批是一张**空表单**的 elicitation
   * （`requestedSchema.properties = {}`，`_meta.codex_approval_kind = "mcp_tool_call"`），适配层当时
   * 只认「恰好一个枚举字段」，卡片画成「此授权表单暂不支持，无法批准」、accept 被改写成 decline ——
   * 电脑操控的写动作在这一档**永远落不下去**（任何要审批的 MCP 写工具都一样）。
   * 修法见 `kernel-adapter/src/approvals.ts` 的 `mcpToolApproval` 与 `main/mcp-tool-approval-view.ts`。
   */
  test('请求批准档：写动作再批一次，批了才落到应用上', async ({ page, electronApp }) => {
    await enableComputerUse(page, electronApp);
    const value = newMarker('WRITTEN');
    const marker = newMarker('WRITE');
    await scriptComputerUse(electronApp, marker, [
      /* 0 */ { tool: 'list_apps', args: {} },
      /* 1 */ { tool: 'get_app_state', args: { app: TEXTEDIT } },
      /* 2 */ {
        tool: 'set_value',
        args: { app: TEXTEDIT, element_index: BODY_ELEMENT, value },
        withState: true,
      },
      /* 3 */ { tool: 'get_app_state', args: { app: TEXTEDIT } },
      /* 4 */ { text: '已写入，重新读取确认正文就是你给的那一行。' },
    ]);
    await send(page, `在 TextEdit 里写一行字 ${marker}`);
    await grantTextEdit(page);

    // ① 准入之后，写动作还要一张卡；它到之前，Helper 上什么都没写
    const outcome = await writeOutcome(page, electronApp, value);
    expect(outcome.landed, '写动作没有弹审批卡就落到了应用上：应用准入替代了动作审批').not.toBe(
      true,
    );
    expect(outcome.card, '写动作的审批卡批不了（只有拒绝 / 取消）').not.toContain('暂不支持');
    // 卡上要说清在哪个 App、对哪个目标、做什么、会发送什么（12 §7.4），不能是内核的英文兜底句
    expect(outcome.card).not.toContain('Allow the cua_repl MCP server');
    expect(outcome.card).toContain('电脑操控将在 com.apple.TextEdit 上填入内容');
    expect(outcome.card).toContain('目标：界面元素 #2');
    expect(outcome.card).toContain(value);
    const card = page.getByRole('alertdialog', { name: '需要你确认' });
    // 电脑操控的写动作只能一次一批（内核对 writes 档也会把「本次会话」降回「这一次」）
    await expect(card.getByRole('button', { name: '本次任务内都允许' })).toHaveCount(0);

    // ② 点允许 → 值落到应用上 → 动作之后重新读，新状态里有这个值
    await card.getByRole('button', { name: /^允许/ }).first().click();
    await expect
      .poll(async () => (await fakeDocument(electronApp)).body, { timeout: 30_000 })
      .toBe(value);
    expect(await stepBody(electronApp, marker, 4)).toContain(value);
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 60_000,
    });

    // ③ 写动作的记录不回显参数（写进去的值就是用户的正文），审计里也没有
    await expandComputerUseItems(page);
    const records = await page
      .locator('.ew-computer-use-record')
      .filter({ hasText: '电脑操控记录已保存到此任务' })
      .allInnerTexts();
    expect(records.length, '写动作没有留下记录').toBeGreaterThan(0);
    for (const record of records) expect(record, '记录回显了写进应用的值').not.toContain(value);
    const audit = await page.evaluate(() => window.evowork.getAudit());
    expect(JSON.stringify(audit), '写进应用的值进了审计').not.toContain(value);
  });

  /*
   * 12 §7.3「完全访问」：普通写动作不逐次弹卡 —— 但内容告知与应用准入照样要问（它们是宿主的闸，
   * 不是内核的审批档），硬禁止照样挡。
   */
  test('完全访问：写动作不再逐次弹卡，告知、准入与硬禁止照旧', async ({ page, electronApp }) => {
    await enableComputerUse(page, electronApp);
    await page.getByRole('button', { name: '审批档' }).click();
    await page.locator('.ew-menu-item').filter({ hasText: '完全访问' }).click();
    await page.getByRole('button', { name: '仅当前任务使用完全访问' }).click();
    await expect(page.getByRole('button', { name: '审批档' })).toContainText('完全访问');

    const value = newMarker('FULL');
    const marker = newMarker('FULLACCESS');
    await scriptComputerUse(electronApp, marker, [
      /* 0 */ { tool: 'list_apps', args: {} },
      /* 1 */ { tool: 'get_app_state', args: { app: TEXTEDIT } },
      /* 2 */ {
        tool: 'set_value',
        args: { app: TEXTEDIT, element_index: BODY_ELEMENT, value },
        withState: true,
      },
      /* 3 */ { tool: 'get_app_state', args: { app: SYSTEM_SETTINGS } },
      /* 4 */ { text: '写好了；系统设置需要你自己改。' },
    ]);
    await send(page, `在 TextEdit 里写一行字，再改一下系统设置 ${marker}`);

    // 完全访问也要先告知、先准入
    await grantTextEdit(page);
    /*
     * 2026-10-05 首次跑红在这里，已修：完全访问的审批策略是 `granular`（为了让删除仍然问），而内核
     * 只在 `approval_policy == never` 时自动放行 MCP 写工具（`codex-mcp/src/mcp/mod.rs` 的
     * `mcp_permission_prompt_is_auto_approved`）—— 这一档下写动作照样弹卡。现在由适配层按
     * 「删除仍然要问，别的一律不问」放行（`approvals.ts` 的 `autoApproveMcpToolCalls`）。
     */
    const outcome = await writeOutcome(page, electronApp, value);
    expect(outcome.card, '完全访问下写动作仍然弹了审批卡').toBeUndefined();
    // 系统设置：完全访问也覆盖不了硬禁止（CU-Q6）
    expect(await stepBody(electronApp, marker, 4)).toContain('POLICY_DENIED');
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 60_000,
    });
    const cards = await page.getByRole('alertdialog').count();
    expect(cards, '完全访问下还剩一张没答的卡').toBe(0);
    expect(
      (await helperCalls(electronApp)).filter((call) => call.app === SYSTEM_SETTINGS),
      '完全访问下系统设置被交给了 Helper',
    ).toEqual([]);
  });

  /*
   * 12 §5.3 有 `APP_NOT_FOUND`。模型把 `list_apps` 给的显示名当成 id 传过来时，该拿到的是
   * 「找不到这个应用」—— 它还能回头用规范 id 再试；而 SKILL 规定 `POLICY_DENIED` 要**立即停止**。
   *
   * 2026-10-05 MiMo flash 真跑出来，已修：模型传了 `"app": "TextEdit"`，宿主当时一律回
   * `POLICY_DENIED`，模型照规矩停下，告诉用户「TextEdit 被系统/权限策略拒绝」——
   * 一个能改正的笔误，变成了一句误导人的硬停。
   */
  test('认不出的应用名：回 APP_NOT_FOUND，不冒充策略拒绝', async ({ page, electronApp }) => {
    await enableComputerUse(page, electronApp);
    const marker = newMarker('UNKNOWN');
    await scriptComputerUse(electronApp, marker, [
      { tool: 'list_apps', args: {} },
      { tool: 'get_app_state', args: { app: 'TextEdit' } },
      { text: '我换成规范 id 再试。' },
    ]);
    await send(page, `看看 TextEdit 里写了什么 ${marker}`);
    const card = page.getByLabel('需要你回答');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.getByRole('button', { name: '继续并启用' }).click();

    const afterRead = await stepBody(electronApp, marker, 2);
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 60_000,
    });
    expect(
      (await helperCalls(electronApp)).some((call) => call.method === 'get_app_state'),
      '认不出的应用被交给了 Helper 去读',
    ).toBe(false);
    expect(afterRead, '认不出的应用名被当成了策略拒绝').not.toContain('POLICY_DENIED');
    expect(afterRead).toContain('APP_NOT_FOUND');
    // 给模型一句它能照做的话：用 list_apps 的 bundle id 再试（12 §5.3 的 message）
    expect(afterRead).toContain('bundle id');
  });

  test('不同意传输：Helper 一次都没被问过，同一任务里也不再追问', async ({ page, electronApp }) => {
    await enableComputerUse(page, electronApp);
    const marker = newMarker('REFUSE');
    await scriptComputerUse(electronApp, marker, [
      { tool: 'list_apps', args: {} },
      { tool: 'get_app_state', args: { app: TEXTEDIT } },
      { text: '你没有同意，我不读取任何应用。' },
    ]);
    await send(page, `看看 TextEdit 里写了什么 ${marker}`);

    const card = page.getByLabel('需要你回答');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.getByRole('button', { name: '拒绝', exact: true }).click();

    // 第二次调用直接 APP_DENIED，不再弹卡 —— 拒绝过还反复问，等于逼用户点同意
    const afterRefuse = await stepBody(electronApp, marker, 1);
    expect(afterRefuse).toContain('APP_DENIED');
    const afterSecond = await stepBody(electronApp, marker, 2);
    expect(afterSecond).toContain('APP_DENIED');
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 60_000,
    });
    await expect(page.getByLabel('需要你回答')).toHaveCount(0);

    expect(
      (await helperCalls(electronApp)).map((call) => call.method),
      '用户拒绝了传输，Helper 却被调用了',
    ).toEqual(['health']);
    await expect(
      page.locator('.ew-approval-bar[role="status"]').filter({ hasText: '正在使用' }),
    ).toHaveCount(0);
  });

  test('始终允许：设置页列出这一条，撤销后立即消失、落盘也清掉', async ({ page, electronApp }) => {
    await enableComputerUse(page, electronApp);
    const marker = newMarker('ALWAYS');
    await scriptComputerUse(electronApp, marker, [
      { tool: 'get_app_state', args: { app: TEXTEDIT } },
      { text: '读到了。' },
    ]);
    await send(page, `看看 TextEdit 里写了什么 ${marker}`);

    const card = page.getByLabel('需要你回答');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.getByRole('button', { name: '继续并启用' }).click();
    await expect(card).toContainText('TextEdit');
    await card.getByRole('button', { name: '始终允许此应用' }).click();
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 60_000,
    });

    const grantsPath = join(await e2eHome(electronApp), '.evowork', 'computer-use-grants.json');
    // 持久授权按签名身份存，不存界面内容
    const grants = JSON.parse(readFileSync(grantsPath, 'utf8'));
    expect(grants[TEXTEDIT]).toEqual({ identity: 'fake-signature-textedit', allowed: true });
    const canary = await electronApp.evaluate(() => globalThis.__evoworkE2E.computerUse.canary);
    expect(readFileSync(grantsPath, 'utf8')).not.toContain(canary);

    const section = await openComputerUseSettings(page);
    const row = section.locator('p').filter({ hasText: `${TEXTEDIT} · 允许` });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '撤销授权' }).click();
    await expect(section).not.toContainText(TEXTEDIT);
    expect(existsSync(grantsPath)).toBe(true);
    expect(JSON.parse(readFileSync(grantsPath, 'utf8'))).toEqual({});
  });
});
