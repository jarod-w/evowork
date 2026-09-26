/**
 * **第四条真交互旅程：在界面上换一个模型，下一回合真的用它。**
 *
 * 「换了但没换成」是这条链路最典型的失败样子：下拉框的标签变了，回合照旧发给旧模型，
 * 而界面上**没有任何提示** —— 用户以为自己在用便宜的那个，账单上是另一回事。
 * 所以断言不落在「标签变了」，落在**网关收到的那个请求里的 model 字段**。
 */
import { expect, test } from './fixtures.mjs';

test('换模型：下拉里选另一个，下一回合的请求就用它', async ({ page, electronApp }) => {
  const trigger = page.getByRole('button', { name: '选择模型' });
  await expect(trigger).toBeVisible();
  const before = (await trigger.textContent())?.trim();

  // ① 下拉里两个模型都在（只有一个的话这条旅程根本无从走起）
  await trigger.click();
  const menu = page.getByRole('menu', { name: '模型列表' });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveCount(2);

  /*
   * ② 选**当前没被选中的那个**，不写死 id：默认选哪个由场景与能力表算出来
   * （model-selection.ts），写死会让这条测试跟着那套算法一起漂。
   */
  // `data-active` 在 menuitem **自身**上，不是后代 —— 所以用 CSS 的 :not，
  // 而不是 Playwright 的 `filter({ hasNot })`（那个查的是后代，会一个都过滤不掉）。
  const target = menu.locator('button[role="menuitem"]:not([data-active="true"])').first();
  const targetLabel = await target.getAttribute('title');
  expect(targetLabel, '菜单项没有完整模型名（title）').toBeTruthy();
  await target.click();

  // ③ 标签换了，而且出现「被你改过」的还原点 —— 用户得知道自己偏离了场景默认值
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toHaveText(before ?? '');
  await expect(
    page.getByRole('button', { name: '模型已被你改过，点击恢复场景默认值' }),
  ).toBeVisible();

  // ④ 发一条，用一段独有的字认领它的请求
  const marker = `MODEL-SWITCH-${Date.now()}`;
  await page.getByLabel('需求输入').fill(`换模型自检 ${marker}`);
  await page.getByRole('button', { name: '发送' }).click();

  /*
   * ⑤ **网关收到的 model 字段必须是新选的那个。**
   *
   * 这是整条链路唯一不会骗人的地方：请求已经穿过渲染层 → IPC → 适配层 → 内核 →
   * 网关，中间任何一环把 modelId 丢了或用了缓存里的旧值，这里都会露出来。
   */
  await expect
    .poll(
      () =>
        electronApp.evaluate((_electron, needle) => {
          const body = globalThis.__evoworkE2E.gateway.requestBodies.find((b) =>
            b.includes(needle),
          );
          if (!body) return null;
          try {
            return JSON.parse(body).model ?? null;
          } catch {
            return 'unparsable';
          }
        }, marker),
      { message: '网关没收到这一回合的请求' },
    )
    .toBe(targetLabel?.split('/').at(-1));
});
