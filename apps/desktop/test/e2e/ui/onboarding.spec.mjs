/** 首次引导设置无项目任务保存位置，不创建默认项目。 */
import { realpathSync } from 'node:fs';
import { expect, test } from './fixtures.mjs';

test.use({ keepOnboarding: true });

test('首次引导：读到隐私承诺 → 选目录 → 走完之后不再回来', async ({
  page,
  electronApp,
}, testInfo) => {
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

  // ② 第二步显示默认保存位置，不展示或创建项目。
  await expect(page.getByRole('heading', { name: '无项目任务的保存位置' })).toBeVisible();

  /*
   * ③ **不选目录也能往下走，而且界面要说出来。**
   *
   * 2026-10-01 Composer 修订（02 / 03 文首的修订基线）：首页默认无项目，无项目任务有自己的独立目录，
   * 所以这一步不再挡人。以前这里断言的是「灰着并说明为什么」—— 那条规则已被取代。
   * 只断言 enabled 不够：用户得知道「可以跳过」，否则看到一个空列表会以为必须选。
   */
  const next = page.getByRole('button', { name: '下一步' });
  await expect(next).toBeEnabled();
  await expect(page.locator('.ew-app-onboarding')).toContainText('点下一步保留当前设置');

  // ④ 选文件夹（系统对话框由主进程的假实现回答，见 harness/ui-entry.mjs）
  const initial = await page.evaluate(() => window.evowork.getWorkingDirectory());
  expect(initial.isDefault).toBe(true);
  await expect(page.locator('.ew-app-onboarding')).toContainText(initial.path);
  const workspace = realpathSync(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace),
  );
  await page.getByRole('button', { name: '选择文件夹' }).click();
  await expect(page.locator('.ew-app-onboarding')).toContainText(workspace);
  expect(await page.evaluate(() => window.evowork.getWorkingDirectory())).toEqual({
    path: workspace,
    isDefault: false,
  });
  expect((await page.evaluate(() => window.evowork.getStartup())).workspaces).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('onboarding-task-directory.png') });
  await page.reload();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.locator('.ew-app-onboarding')).toContainText(workspace);

  // ⑤ 选了目录照样能往下走（选目录是可选的，不是被它反过来锁住）
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
  expect((await page.evaluate(() => window.evowork.getStartup())).workspaces).toEqual([]);
  await expect(page.getByRole('button', { name: '选择项目', exact: true })).toContainText(
    '不使用项目',
  );
  await page.getByLabel('需求输入').fill('ONBOARDING_TASK_DIRECTORY');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getStartup())).tasks.length)
    .toBe(1);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  const startup = await page.evaluate(() => window.evowork.getStartup());
  expect(startup.tasks[0].cwd.startsWith(`${workspace}/`)).toBe(true);
  expect(startup.tasks[0].projectId).toBeNull();
  expect(startup.workspaces).toEqual([]);
});

test('首次引导跳过选目录：沿用默认位置，不创建项目', async ({ page }) => {
  const initial = await page.evaluate(() => window.evowork.getWorkingDirectory());
  expect(initial.isDefault).toBe(true);
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.locator('.ew-app-onboarding')).toContainText(initial.path);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '开始使用' }).click();
  await expect(page.getByLabel('需求输入')).toBeVisible();
  expect(await page.evaluate(() => window.evowork.getWorkingDirectory())).toEqual(initial);
  expect((await page.evaluate(() => window.evowork.getStartup())).workspaces).toEqual([]);
});
