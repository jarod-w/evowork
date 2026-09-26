/**
 * **内核崩了，用户看到什么，之后还能不能接着干。**
 *
 * 断言型 E2E 验的是「内核被 SIGKILL 之后会自己起来」——那是**进程层面**的结论，
 * 它经 preload 桥读一条通知对象就够了。用户那一侧从来没人看过：
 * 屏幕上有没有说明？说完之后这个应用还能用吗？
 *
 * 09 §1 的原话是「**不静默重启**：用户需要知道刚才那个中断的任务发生了什么」。
 * 这条旅程就是那句话的验收面。
 */
import { expect, test } from './fixtures.mjs';

test('内核崩溃：界面如实说出来，而且之后还能继续发任务', async ({ page, electronApp }) => {
  const composer = page.getByLabel('需求输入');
  await expect(composer).toBeVisible();

  // ① 杀掉真内核子进程（控制面在 harness/boot.mjs 里露出来的）
  await electronApp.evaluate(() => {
    globalThis.__evoworkE2E.killKernel();
  });

  /*
   * ② **屏幕上要有一句话。** 通知落成一条 warning Banner（`role="status"`）。
   * 只在日志里写"已重启"不算数 —— 用户刚才那个任务停在半路，而界面什么都不说的话，
   * 他只会以为是自己网不好。
   */
  const banner = page.locator('.ew-banner[data-tone="warning"]').filter({ hasText: '执行内核' });
  await expect(banner, '内核重启了，界面上一个字都没说').toBeVisible({ timeout: 60_000 });
  await expect(banner).toContainText('重启');

  /*
   * ③ **之后还能干活** —— 这才是"恢复"这个词的含义。
   * 只把横幅画出来、而新任务再也发不出去的话，那不是恢复，是一句好听的讣告。
   */
  await electronApp.evaluate(() => {
    globalThis.__evoworkE2E.gateway.scriptNext({ kind: 'text', text: '重启之后我还在。' });
  });
  await composer.fill('内核重启之后还能发吗');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('main', { name: '对话区' })).toContainText('重启之后我还在。', {
    timeout: 60_000,
  });
});
