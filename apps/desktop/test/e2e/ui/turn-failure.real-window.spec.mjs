/**
 * **回合失败时，用户第一眼看到的是人话，不是英文技术信息。**
 *
 * 起因是 2026-09-27 的用户截图：卡片上写着
 * `stream disconnected before completion: idle timeout waiting for SSE`。
 *
 * 03 §8 要求不改写、不归类（`connection refused` 与 `401` 是不同的两件事），
 * 所以原文一个字都不能丢 —— 但它不该占着那句要给人看的话。这条验两层都在。
 */
import { expect, test } from './fixtures.mjs';

test('上游给英文原因：卡片上是人话，原文折在「详情」里', async ({ page, electronApp }) => {
  const RAW = 'stream disconnected before completion: idle timeout waiting for SSE';

  // 让上游一直失败，并指定一句**英文**原因 —— 默认那句是我们自己写的中文，测不到这条
  await electronApp.evaluate((_electron, raw) => {
    globalThis.__evoworkE2E.gateway.failNextUpstream(99, raw);
  }, RAW);

  await page.getByLabel('需求输入').fill('随便问一句');
  await page.getByRole('button', { name: '发送' }).click();

  const card = page.getByRole('alert', { name: '回合失败' });
  await expect(card).toBeVisible({ timeout: 120_000 });

  /*
   * ① 第一眼那行是人话，而且**不是**那串英文。
   *
   * 断言要落在那个 `<p>` 上，不能落在整张卡上：`<details>` 收起来时内容**仍在 DOM 里**，
   * `toContainText` 照样看得见 —— 第一版就是这么假红的（功能其实是对的）。
   */
  const headline = card.locator('p').first();
  await expect(headline).toContainText('重试');
  await expect(headline).not.toContainText('idle timeout');

  /*
   * ② 原文还在，只是折起来了。**默认收起** —— 摊开会把人话和两个动作按钮挤下去，
   * 而用户第一眼要的是"我现在能做什么"。
   */
  const details = card.locator('details.ew-turn-failure-detail');
  await expect(details).toBeVisible();
  await expect(details, '详情默认应当是收起的').not.toHaveAttribute('open', '');
  await details.getByText('详情').click();
  await expect(details).toContainText(RAW);
});
