/** 共用真 DOM 旅程；图片接口真实性由 fixture/real project 明确区分。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, startTaskInWorkspace } from './fixtures.mjs';

export async function imageGenerationJourney(
  { page, electronApp },
  testInfo,
  model,
  accept = true,
  expectedFailure,
) {
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '模型', exact: true })
    .click();
  await page.getByLabel('启用 AI 图片').check();
  expect(
    await page
      .getByLabel('图片模型', { exact: true })
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.value)),
  ).toEqual(['doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-pro-260628']);
  await page.getByLabel('图片模型', { exact: true }).selectOption(model);
  await page
    .getByLabel('图片接口地址')
    .fill(process.env.EVOWORK_UI_IMAGE_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3/');
  // 密钥从进程环境注入宿主；真实 Ark 密钥不会进入 renderer / 截图 / 测试参数。
  await page.getByRole('button', { name: '保存图片设置' }).click();
  await expect(page.getByText('已保存。图片工具对新任务生效；已有任务请重新打开。')).toBeVisible();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await startTaskInWorkspace(page, electronApp, '生成一张天空图片');
  const firstApproval = page.getByRole('alertdialog', { name: '需要你确认' });
  await expect(firstApproval).toBeVisible({ timeout: 60_000 });
  const allowTool = firstApproval.getByRole('button', { name: '允许这一次', exact: true });
  if (await allowTool.count()) await allowTool.click();
  const approval = page
    .getByRole('alertdialog')
    .filter({ has: page.getByRole('button', { name: '确认本次上传与费用', exact: true }) });
  await expect(approval).toBeVisible({ timeout: 60_000 });
  await expect(approval).toContainText(model);
  const stats = () => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.stats());
  expect((await stats()).imagePosts, '费用确认之前不应请求图片服务商').toBe(0);
  await approval
    .getByRole('button', { name: accept ? '确认本次上传与费用' : '拒绝', exact: true })
    .click();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 330_000,
  });
  const observed = await stats();
  const task = await page.evaluate(async () => {
    const { tasks } = await window.evowork.getStartup();
    return tasks.find((t) => t.title === '生成一张天空图片') ?? tasks[0];
  });
  const operations = await page.evaluate(
    (threadId) => window.evowork.getImageOperations({ threadId }),
    task.id,
  );
  writeFileSync(
    testInfo.outputPath('image-statistics.json'),
    JSON.stringify({ stats: observed, operations }, null, 2),
  );
  await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
  expect(operations).toHaveLength(1);
  if (!accept) {
    await expect(page.getByText('已取消生成，没有发起付费请求。', { exact: true })).toBeVisible();
    expect((await stats()).imagePosts).toBe(0);
    expect(operations[0].status).toBe('cancelled');
    return;
  }
  if (expectedFailure) {
    expect(operations[0]).toMatchObject({ status: 'failed', errorCode: expectedFailure });
    expect(observed).toMatchObject({ imagePosts: 1, viewCalls: 0 });
    await expect(page.getByText('图片生成失败：' + expectedFailure, { exact: true })).toBeVisible();
    await expect(page.getByText('已取消生成，没有发起付费请求。', { exact: true })).toHaveCount(0);
    return;
  }
  expect(operations[0], '图片操作必须成功；服务商错误不能被当作正常取消或成功收尾').toMatchObject({
    status: 'completed',
    model,
    submitted: true,
  });
  await expect(page.getByText('天空图片已生成并查看，任务完成。', { exact: true })).toBeVisible();
  expect(observed).toMatchObject({
    imagePosts: 1,
    imageModels: [model],
    viewCalls: 1,
    visualRequests: 1,
    imageBytesInToolText: false,
  });
  expect(observed.imageUrlLength).toBeGreaterThan(1000);
  expect(task.status).toBe('completed');
  expect(operations[0].width).toBeGreaterThanOrEqual(2048);
  expect(operations[0].height).toBeGreaterThanOrEqual(1024);
  const results = await page.evaluate(
    (threadId) => window.evowork.getTaskResults({ threadId }),
    task.id,
  );
  const artifact = results.artifacts.find((a) => a.id === operations[0].artifactId);
  expect(artifact).toBeTruthy();
  const bytes = readFileSync(artifact.path);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const imagePath = testInfo.outputPath('generated-sky.png');
  writeFileSync(imagePath, bytes);
  await testInfo.attach('generated-sky.png', { path: imagePath, contentType: 'image/png' });
  await page
    .getByRole('group', { name: '操作记录，已完成' })
    .getByRole('button', { name: /^操作记录：/ })
    .click();
  const card = page.getByLabel('AI 图片操作');
  await expect(card).toContainText('图片已完成');
  await expect(card.getByRole('img', { name: 'AI 生成的图片' })).toBeVisible();
  await card.getByRole('button', { name: '打开图片', exact: true }).click();
  await expect(page.locator('.ew-result-pane img').first()).toBeVisible();
  await testInfo.attach('completed-window.png', {
    body: await page.screenshot({ path: testInfo.outputPath('completed-window.png') }),
    contentType: 'image/png',
  });
  // 重载后成功状态和产物仍在，且不会再次发起付费调用。
  await page.reload();
  await page
    .getByRole('navigation', { name: '侧边栏' })
    .getByRole('button', { name: '生成一张天空图片', exact: true })
    .click();
  await expect(page.getByText('天空图片已生成并查看，任务完成。', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
  expect((await stats()).imagePosts).toBe(1);
  await testInfo.attach('image-statistics.json', {
    body: Buffer.from(JSON.stringify(observed)),
    contentType: 'application/json',
  });
}
