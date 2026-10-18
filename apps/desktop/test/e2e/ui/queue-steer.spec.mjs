/**
 * **多回合时序：运行中的默认值 · 立即插话 · Esc 中断。**
 *
 * 这一组全是**时间上的**行为：同一个动作在「空闲」与「运行中」下含义完全不同。
 * jsdom 里没有时间，断言型 E2E 又是经 preload 桥直接调 `send({steer:true})` ——
 * 两者都绕过了用户真正走的那条路：在运行中的输入框里敲回车。
 *
 * **三条收获**：
 *   · 「编辑排队项」原本用 `window.prompt`，而 Electron 直接抛
 *     「prompt() is not supported.」—— 点了什么都不会发生，界面上毫无提示。
 *     已改成应用内对话框，回归钉在 `test/composer.test.tsx`（钉的是**机制**，
 *     因为 jsdom 有 `prompt` 而 Electron 没有，只钉结果是钉不住的）。
 *   · **运行中追问根本不入队** —— 这条把一个更深的缺陷带了出来：我们手写的
 *     `ThreadStatus` 四个变体全错（内核是 `#[serde(tag = "type")]` 的内部标签联合，
 *     `thread.rs:1645`），于是 `deriveStatus` 永远认不出"活动中"，正在跑的任务在
 *     投影里是 `interrupted`，追问因此走了"另起一个回合"那一支。已订正。
 *   · 单测全绿是因为它们用我们自己那套错类型造数据 —— **代码与测试互相印证、
 *     一起偏离内核**。`scripts/kernel-contract.mjs` 只校验我们**发出去**的形状，
 *     收进来的通知载荷不在它的覆盖面里。
 */
import { expect, test } from './fixtures.mjs';

/** 让下一个回合挂住不收尾 —— 「运行中」这个状态才造得出来 */
function holdNextTurn(electronApp, marker) {
  return electronApp.evaluate((_, text) => {
    globalThis.__evoworkE2E.gateway.scriptWhen(`hold-${text}`, (view) => view.text.includes(text), {
      kind: 'hold',
    });
  }, marker);
}
async function expectHeld(electronApp) {
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
}
function releaseHeldTurn(electronApp) {
  return electronApp.evaluate(() => {
    globalThis.__evoworkE2E.gateway.releaseScriptedTurn();
  });
}
/** 网关收到的请求里有没有这段字 */
function gatewaySaw(electronApp, needle) {
  return electronApp.evaluate(
    (_electron, text) =>
      globalThis.__evoworkE2E.gateway.requestBodies.some((b) => b.includes(text)),
    needle,
  );
}

test('运行中：默认是排队而不是插话', async ({ page, electronApp }) => {
  /*
   * 04 §5.5 的产品决定：**默认排队**。插话会打断当前思路。
   * 默认反了的话，用户每次追问都在砸自己的任务，而界面上看不出区别 ——
   * 所以钉住「开关在、且没勾」，外加 tooltip 把两者差别说清了。
   */
  const input = page.getByLabel('需求输入');
  await holdNextTurn(electronApp, '写一份很长的报告');
  await input.fill('写一份很长的报告');
  await input.press('Enter'); // ⏎ 发送 —— 与点击发送一致，停止是独立动作
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'running');
  await expectHeld(electronApp);

  const steerToggle = page.getByRole('radio', { name: '立即插话' });
  await expect(steerToggle).toBeVisible();
  await expect(steerToggle).not.toBeChecked();

  /*
   * 这个开关**只在运行中存在** —— 空闲时摆着它，等于承诺一个此刻做不到的动作。
   * 用 Esc 停止而不是放行网关：停止是确定的，而"放行之后多久回到 idle"取决于内核，
   * 把一个不确定的等待塞进断言只会换来偶发红。
   */
  await input.press('Escape');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await expect(steerToggle).toHaveCount(0);
  await releaseHeldTurn(electronApp);
});

test('运行中：单次插话、发送反馈与下一条恢复排队', async ({ page, electronApp }, info) => {
  const input = page.getByLabel('需求输入');
  const composer = page.getByLabel('输入区');

  await holdNextTurn(electronApp, '列个提纲');
  await input.fill('列个提纲');
  await input.press('Enter');
  await expect(composer).toHaveAttribute('data-run-state', 'running');
  await expectHeld(electronApp);

  await page.getByRole('radio', { name: '立即插话' }).check();

  const marker = `STEER-${Date.now()}`;
  await input.fill(`插话：只要三条 ${marker}`);
  await page.getByRole('button', { name: '立即插话', exact: true }).click();
  await expect(page.getByLabel('发送状态')).toHaveText('已发送，正在调整方向');
  await page.screenshot({ path: info.outputPath('steered-status.png') });
  await expect(page.getByRole('radio', { name: '排队发送' })).toBeChecked();

  /*
   * **没有排队区**才说明走的是 `turn/steer` 而不是入队。
   * 配合明确回执与队列断言，确认它没有被降级为排队。
   */
  await expect(page.getByLabel('排队中的追问')).toHaveCount(0);
  const nextMarker = `QUEUE-AFTER-${Date.now()}`;
  await input.fill(nextMarker);
  await page.getByRole('button', { name: '排队发送', exact: true }).click();
  await expect(page.getByLabel('发送状态')).toHaveText('等待当前任务完成');
  await expect(page.getByLabel('排队中的追问')).toContainText(nextMarker);
  expect(await gatewaySaw(electronApp, nextMarker)).toBe(false);
  await page.screenshot({ path: info.outputPath('single-send-reset-and-queue.png') });

  await releaseHeldTurn(electronApp);
  await expect.poll(() => gatewaySaw(electronApp, marker), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => gatewaySaw(electronApp, nextMarker), { timeout: 60_000 }).toBe(true);
});

test('运行中：Esc 把回合停下来', async ({ page, electronApp }) => {
  /*
   * 04 §5.5 给了两条中断路径：点按钮，和 **Esc / ⌘.**。
   * 按钮那条另有一条旅程；键盘这条只有真窗口发得出来 —— jsdom 里没有键盘。
   */
  const input = page.getByLabel('需求输入');
  const composer = page.getByLabel('输入区');

  await holdNextTurn(electronApp, '再写一份很长的报告');
  await input.fill('再写一份很长的报告');
  await input.press('Enter');
  await expect(composer).toHaveAttribute('data-run-state', 'running');
  await expectHeld(electronApp);

  await input.press('Escape');
  await expect(composer).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

  await releaseHeldTurn(electronApp);
});

test('运行中：追问进排队区，能调序、能编辑、能删除，放行后自动跑', async ({
  page,
  electronApp,
}) => {
  /*
   * 这条旅程是 `ThreadStatus` 那个缺陷的**回归**：修之前排队区根本不出现，
   * 因为适配层认不出"活动中"，把追问送去另起了一个回合。
   */
  const input = page.getByLabel('需求输入');
  await holdNextTurn(electronApp, '写一份很长的报告');
  await input.fill('写一份很长的报告');
  await input.press('Enter');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'running');
  await expectHeld(electronApp);

  // ① 回车追问 → 进排队区，**不是**现在就发给模型
  await input.fill('排队甲');
  await input.press('Enter');
  const queue = page.getByLabel('排队中的追问');
  await expect(queue).toBeVisible();
  await expect(queue).toContainText('排队中 (1)');
  expect(await gatewaySaw(electronApp, '排队甲'), '排队项不该现在就发给模型').toBe(false);

  await input.fill('排队乙');
  await input.press('Enter');
  await expect(queue).toContainText('排队中 (2)');

  // ② 调序
  await queue.getByRole('button', { name: '上移排队项：排队乙' }).click();
  await expect
    .poll(async () => (await queue.locator('.ew-queue-text').allInnerTexts())[0]?.trim())
    .toBe('排队乙');

  // ③ 编辑（`window.prompt` 那个缺陷的落点：修之前点了毫无反应）
  await queue.getByRole('button', { name: '编辑排队项：排队乙' }).click();
  const field = page.getByRole('textbox', { name: '排队项内容' });
  await expect(field).toBeVisible();
  await field.fill('排队乙已改');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(queue).toContainText('排队乙已改');

  // ④ 删除
  await queue.getByRole('button', { name: '删除排队项：排队甲' }).click();
  await expect(queue).toContainText('排队中 (1)');
  await expect(queue).not.toContainText('排队甲');

  /*
   * ⑤ **放行之后排队项自己跑起来，而且跑的是编辑后的文本。**
   * 这是唯一能证伪"编辑只改了界面显示"的地方 —— 改的是显示，还是真要发出去的东西。
   */
  await releaseHeldTurn(electronApp);
  await expect.poll(() => gatewaySaw(electronApp, '排队乙已改'), { timeout: 60_000 }).toBe(true);
});

test('运行中：缺失活动回合投影时插话改为排队，完整显示原因', async ({
  page,
  electronApp,
}, info) => {
  const input = page.getByLabel('需求输入');
  await holdNextTurn(electronApp, '等待缺失回合投影的插话');
  await input.fill('等待缺失回合投影的插话');
  await input.press('Enter');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'running');
  await expectHeld(electronApp);
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
  // 故障注入仅移除宿主活动回合投影；真实内核与在途响应仍运行。
  // 后续点击 → IPC → 适配层降级 → 原生队列 → 模型请求均走实际链路。
  await electronApp.evaluate(() => {
    const { host } = globalThis.__evoworkE2E;
    const row = host.store.db
      .prepare(
        "SELECT thread_id AS id, last_turn_id FROM thread_projection WHERE derived_status = 'running' LIMIT 1",
      )
      .get();
    if (!row?.last_turn_id) throw new Error('没有在途回合');
    host.adapter.events.handle('turn/completed', {
      threadId: row.id,
      turn: { id: row.last_turn_id, status: 'completed', items: [] },
    });
    host.adapter.events.handle('thread/status/changed', {
      threadId: row.id,
      status: { type: 'active', activeFlags: [] },
    });
  });
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'running');
  await expectHeld(electronApp);
  await page.getByRole('radio', { name: '立即插话' }).check();
  const marker = `FALLBACK-${Date.now()}`;
  await input.fill(marker);
  await page.getByRole('button', { name: '立即插话', exact: true }).click();
  await expect(page.getByLabel('发送状态')).toHaveText(
    '等待当前任务完成 当前没有可插话的回合，这条输入已改为排队。',
  );
  await expect(page.getByLabel('排队中的追问')).toContainText(marker);
  await expect(page.getByRole('radio', { name: '排队发送' })).toBeChecked();
  expect(await gatewaySaw(electronApp, marker)).toBe(false);
  await page.screenshot({ path: info.outputPath('steer-fallback-reason.png') });
  await releaseHeldTurn(electronApp);
  await expect.poll(() => gatewaySaw(electronApp, marker), { timeout: 60_000 }).toBe(true);
});

test('运行中：窄窗发送和停止独立，停止保留草稿；下轮恢复排队', async ({
  page,
  electronApp,
}, info) => {
  const input = page.getByLabel('需求输入');
  await holdNextTurn(electronApp, '等待用户停止的报告');
  await input.fill('等待用户停止的报告');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'running');
  await expectHeld(electronApp);
  await page.getByRole('radio', { name: '立即插话' }).check();
  const draft = `未发送草稿-${Date.now()}`;
  await input.fill(draft);
  for (const width of [1000, 600]) {
    await electronApp.evaluate(
      ({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setSize(nextWidth, 800),
      width,
    );
    // 窄窗侧栏是覆盖式导航；收起后验证用户实际操作的完整 Composer。
    if (width === 600) await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '立即插话', exact: true })).toBeEnabled();
    const controls = await page.locator('.ew-composer-run-actions').evaluate((element) => {
      const r = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll('button')].map((button) => {
        const b = button.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      });
      const card = element.closest('.ew-composer-input-card').getBoundingClientRect();
      const options = document.querySelector('.ew-follow-up-options').getBoundingClientRect();
      return {
        within: r.left >= 0 && r.right <= innerWidth,
        insideCard: r.top >= card.top && r.bottom <= card.bottom,
        optionsVisible: options.left >= 0 && options.right <= innerWidth,
        overlap:
          buttons[0].left < buttons[1].right &&
          buttons[1].left < buttons[0].right &&
          buttons[0].top < buttons[1].bottom &&
          buttons[1].top < buttons[0].bottom,
      };
    });
    expect(controls).toEqual({
      within: true,
      insideCard: true,
      optionsVisible: true,
      overlap: false,
    });
    await page.screenshot({ path: info.outputPath(`send-and-stop-${width}.png`) });
  }
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await expect(input).toHaveValue(draft);
  expect(await gatewaySaw(electronApp, draft)).toBe(false);
  await releaseHeldTurn(electronApp);
  await holdNextTurn(electronApp, '再次运行验证恢复默认方式');
  await input.fill('再次运行验证恢复默认方式');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('radio', { name: '排队发送' })).toBeChecked();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await releaseHeldTurn(electronApp);
});

test('切换运行任务或回到新任务时不携带插话选择', async ({ page, electronApp }) => {
  const input = page.getByLabel('需求输入');
  const sidebar = page.getByRole('navigation', { name: '侧边栏' });
  const first = '切换前的运行任务';
  const second = '切换后的运行任务';
  await holdNextTurn(electronApp, first);
  await input.fill(first);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expectHeld(electronApp);
  await page.getByRole('radio', { name: '立即插话' }).check();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: '本次发送方式' })).toHaveCount(0);
  await sidebar.getByRole('button', { name: first, exact: true }).click();
  await expect(page.getByRole('radio', { name: '排队发送' })).toBeChecked();
  await page.getByRole('radio', { name: '立即插话' }).check();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await holdNextTurn(electronApp, second);
  await input.fill(second);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('radio', { name: '排队发送' })).toBeChecked();
  await page.getByRole('radio', { name: '立即插话' }).check();
  await sidebar.getByRole('button', { name: first, exact: true }).click();
  await expect(page.getByRole('radio', { name: '排队发送' })).toBeChecked();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await sidebar.getByRole('button', { name: second, exact: true }).click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
});
