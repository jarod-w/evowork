/**
 * **第三条真交互旅程：首次运行引导。**
 *
 * 它是每个用户看到的**第一样东西**，也是最没被自动化碰过的一段：断言型 E2E 从不经过它
 * （它们只经 preload 桥说话），而 jsdom 的组件测试渲染的是一个脱离了真实 startup 状态的壳。
 *
 * 这一段出过一次真事故：`showOpenDialog` 没注入时，引导会卡在「选一个项目」——
 * `blockingReason` 要求至少有一个工作空间，而干净机器上一个都没有，**整个应用打不开**
 * （bootstrap.ts:70-74，2026-09-06 实测撞到）。这条旅程就是钉住那种情况。
 */
import { expect, test } from './fixtures.mjs';

test.use({ keepOnboarding: true });

test('首次引导：读到隐私承诺 → 选目录 → 走完之后不再回来', async ({ page, electronApp }) => {
  /*
   * ① **两句隐私承诺都要在。**
   *
   * 这两句是 Q3 的对外表达，onboarding.tsx 的注释写着「措辞不可放宽也不可夸大」：
   * 少讲「模型调用会出网」是骗人；把「执行在本机」说成"完全不出网"同样是骗人。
   * 只讲一句的版本在截图里看着挺好 —— 所以要用断言钉住**两句都在**。
   */
  await expect(page.getByRole('heading', { name: '欢迎使用 EvoWork' })).toBeVisible();
  await expect(page.locator('.ew-app-onboarding')).toContainText('都在这台电脑上完成');
  await expect(page.locator('.ew-app-onboarding')).toContainText('模型调用需要联网');

  await page.getByRole('button', { name: '下一步' }).click();

  // ② 第二步：一个工作空间都还没有
  await expect(page.getByRole('heading', { name: '选一个项目' })).toBeVisible();

  /*
   * ③ **这时「下一步」必须是灰的，而且要说出为什么。**
   *
   * onboarding.tsx 里写着「一个灰着的按钮不告诉用户为什么灰，比不给按钮更让人困惑」。
   * 只断言 disabled 不够 —— 那样文案丢了测试照样绿，而用户会卡在一个不解释自己的界面上。
   */
  const next = page.getByRole('button', { name: '下一步' });
  await expect(next).toBeDisabled();
  await expect(next).toHaveAttribute('title', /.+/);

  // ④ 选文件夹（系统对话框由主进程的假实现回答，见 harness/ui-entry.mjs）
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  await page.getByRole('button', { name: '选择文件夹' }).click();
  await expect(page.locator('.ew-app-onboarding')).toContainText(workspace);

  // ⑤ 选完之后才解锁 —— 这正是那次"整个应用打不开"的反面
  await expect(next).toBeEnabled();
  await next.click();

  await expect(page.getByRole('heading', { name: '文档解析组件' })).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByRole('heading', { name: '好了' })).toBeVisible();
  await page.getByRole('button', { name: '开始使用' }).click();

  /*
   * ⑥ **走完就进工作台，而且不再回来。**
   *
   * "不再回来"是这一步真正的后果：`onboarded` 没落库的话，下次启动又是引导 ——
   * 而那个缺陷在单次运行里完全看不出来。所以这里 reload 一次再看。
   */
  await expect(page.getByLabel('需求输入')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('需求输入')).toBeVisible();
  await expect(page.getByRole('heading', { name: '欢迎使用 EvoWork' })).toHaveCount(0);
});
