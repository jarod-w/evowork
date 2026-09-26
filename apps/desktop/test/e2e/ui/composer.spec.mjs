/**
 * **第一条真交互旅程：发一条需求，让它跑起来，再把它停下来。**
 *
 * 这条路径此前只在 jsdom 里测过组件、在断言型 E2E 里经 preload 桥调过
 * `window.evowork.send(...)` —— 两者都跳过了**用户真正做的那件事**：
 * 在输入框里打字、按发送按钮。中间那一段（受控 textarea 的事件、按钮的
 * 可用态、运行中按钮从「发送」变成「中断」、点它之后回合真的停下）
 * 从来没有被自动化验过，jsdom 也验不了 —— 它根本不做布局，也发不出可信输入事件。
 */
import { expect, test } from './fixtures.mjs';

test('输入 → 发送 → 进入运行态 → 中断', async ({ page, electronApp }) => {
  /*
   * 假网关会**扣住正文里带这段字的那个回合**不收尾（见 harness/fake-gateway.mjs）。
   * 于是「一个正在运行的回合」不需要任何脚本化动作就能造出来 —— 这正是
   * 「停止」按钮出现的条件，而它是这条旅程要点的那个按钮。
   */
  const marker = await electronApp.evaluate(() => globalThis.__evoworkE2E.turnMarker);
  // 取不到就当场停下：`undefined` 往下走会让后面每条断言都失去意义却仍然变绿
  expect(marker, '控制面里没有 turnMarker').toMatch(/^EVOWORK-/);

  const composer = page.getByLabel('输入区');
  const input = page.getByLabel('需求输入');

  // ① 起手是可发送态，不是运行态
  await expect(composer).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

  // ② 真的在输入框里打字：受控 textarea 的 onChange 必须收到可信事件
  await input.click();
  await input.fill(`帮我写一份很长的报告 ${marker}`);
  await expect(input).toHaveValue(new RegExp(`${marker}$`));

  // ③ 按发送
  await page.getByRole('button', { name: '发送' }).click();

  /*
   * ④ **进入运行态**。断言的是后果，不是"点过了"：
   * 输入框清空 + 按钮变成「中断」+ 对话区出现 —— 三件事一起成立，
   * 才说明 send 真的穿过了 IPC、到了内核、并且界面跟着切了状态。
   */
  await expect(composer).toHaveAttribute('data-run-state', 'running');
  const stop = page.getByRole('button', { name: '中断' });
  await expect(stop).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toHaveCount(0);
  await expect(page.getByRole('main', { name: '对话区' })).toBeVisible();

  // ⑤ 模型回的第一片文字真的画出来了（假网关在扣住之前发了一条 delta）
  await expect(page.getByRole('main', { name: '对话区' })).toContainText('E2E response');

  /*
   * ⑤b **确认这个运行态是真被扣住的**，不是回合自己出了错。
   *
   * 少了这一条，下面那句"停止之后回到 idle"就是空的：回合失败也会回到 idle，
   * 测试照样变绿，而「停止」这个按钮到底有没有用一个字都没验到。
   */
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.turnClaimed()))
    .toBe(true);

  /*
   * ⑥ **点停止，回合真的停下来。**
   *
   * 这一条是整条旅程里最容易"看起来对"的地方：`turn/interrupt` 少一个 turnId
   * 内核就只回 -32600，按钮点了什么都不会发生 —— 而界面上没有任何提示。
   * 所以断言的是运行态退回 idle、「发送」按钮回来了，不是"点过了"。
   */
  await stop.click();
  await expect(composer).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
});
