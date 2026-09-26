/**
 * **多回合时序：运行中的默认值 · 立即插话 · Esc 中断。**
 *
 * 这一组全是**时间上的**行为：同一个动作在「空闲」与「运行中」下含义完全不同。
 * jsdom 里没有时间，断言型 E2E 又是经 preload 桥直接调 `send({steer:true})` ——
 * 两者都绕过了用户真正走的那条路：在运行中的输入框里敲回车。
 *
 * **两条收获**：
 *   · 「编辑排队项」原本用 `window.prompt`，而 Electron 直接抛
 *     「prompt() is not supported.」—— 点了什么都不会发生，界面上毫无提示。
 *     已改成应用内对话框，回归钉在 `test/composer.test.tsx`（那条断言钉的是**机制**，
 *     因为 jsdom 有 `prompt` 而 Electron 没有，只钉结果是钉不住的）。
 *   · **运行中追问不进排队区**：界面上排队区始终不出现，而内核侧队列也是空的
 *     （同样参数经桥调用时 `send()` 会返回 `queued: true`）。根因未定位，
 *     所以这里**不写排队相关的断言** —— 钉一个坏行为比不钉更糟。见 status.md。
 */
import { expect, test } from './fixtures.mjs';

/** 让下一个回合挂住不收尾 —— 「运行中」这个状态才造得出来 */
function holdNextTurn(electronApp) {
  return electronApp.evaluate(() => {
    globalThis.__evoworkE2E.gateway.scriptNext({ kind: 'hold' });
  });
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
  await holdNextTurn(electronApp);
  await input.fill('写一份很长的报告');
  await input.press('Enter'); // ⏎ 发送 —— 运行中也走这条路，因为发送按钮已经变成「中断」
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'running');

  const steerToggle = page.getByRole('checkbox', { name: '立即插话' });
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

test('运行中：勾了「立即插话」之后，话真的插进了模型请求', async ({ page, electronApp }) => {
  const input = page.getByLabel('需求输入');
  const composer = page.getByLabel('输入区');

  await holdNextTurn(electronApp);
  await input.fill('列个提纲');
  await input.press('Enter');
  await expect(composer).toHaveAttribute('data-run-state', 'running');

  await page.getByRole('checkbox', { name: '立即插话' }).check();

  const marker = `STEER-${Date.now()}`;
  await input.fill(`插话：只要三条 ${marker}`);
  await input.press('Enter');

  /*
   * **没有排队区**才说明走的是 `turn/steer` 而不是入队。
   * 适配层在"没有活动回合"时会悄悄改成排队 —— 那种降级从界面上看不出来，
   * 只能靠"排队区没出现"把它挡住。
   */
  await expect(page.getByLabel('排队中的追问')).toHaveCount(0);

  await releaseHeldTurn(electronApp);
  await expect.poll(() => gatewaySaw(electronApp, marker), { timeout: 60_000 }).toBe(true);
});

test('运行中：Esc 把回合停下来', async ({ page, electronApp }) => {
  /*
   * 04 §5.5 给了两条中断路径：点按钮，和 **Esc / ⌘.**。
   * 按钮那条另有一条旅程；键盘这条只有真窗口发得出来 —— jsdom 里没有键盘。
   */
  const input = page.getByLabel('需求输入');
  const composer = page.getByLabel('输入区');

  await holdNextTurn(electronApp);
  await input.fill('再写一份很长的报告');
  await input.press('Enter');
  await expect(composer).toHaveAttribute('data-run-state', 'running');

  await input.press('Escape');
  await expect(composer).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

  await releaseHeldTurn(electronApp);
});
