import { horizontalOverflow, resizeWindow } from './assertions.mjs';
import { expect, test } from './fixtures.mjs';

test('智能体前端：独立入口、会话配置、协作演示与窄窗显示，不创建后台任务', async ({
  page,
  electronApp,
}, testInfo) => {
  page.on('dialog', (dialog) => void dialog.accept().catch(() => undefined));
  const sidebar = page.getByRole('navigation', { name: '侧边栏', exact: true });
  const startup = await page.evaluate(() => window.evowork.getStartup());
  await sidebar.getByRole('button', { name: '智能体', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: '插件', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '智能体', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await resizeWindow(electronApp, 1440, 1000);
  await expect(page.getByRole('article')).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath('agents-list-desktop.png') });
  await page.getByRole('button', { name: '新建智能体', exact: true }).click();
  await page.getByLabel('智能体名称', { exact: false }).fill('页面审阅助手');
  await page
    .getByLabel('角色说明', { exact: false })
    .fill('整理输入材料，生成结构清晰的工作报告。');
  await page.getByLabel('工作指令', { exact: false }).fill('先检查来源，再整理事实与结论。');
  await page.getByRole('checkbox', { name: /文档处理/ }).check();
  await page.screenshot({ path: testInfo.outputPath('agent-editor-desktop.png') });
  await page.getByRole('button', { name: '保存智能体', exact: true }).click();
  await expect(page.getByRole('article', { name: '页面审阅助手', exact: true })).toBeVisible();
  await sidebar.getByRole('button', { name: '插件', exact: true }).click();
  await sidebar.getByRole('button', { name: '智能体', exact: true }).click();
  const card = page.getByRole('article', { name: '页面审阅助手', exact: true });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '开始对话', exact: true }).click();
  const conversation = page.getByRole('dialog', { name: '与页面审阅助手对话', exact: true });
  await conversation.getByLabel('任务需求', { exact: true }).fill('把这份工作记录整理成周报。');
  await conversation.getByRole('button', { name: '预览任务', exact: true }).click();
  await expect(conversation).toContainText('把这份工作记录整理成周报。');
  await conversation.getByRole('button', { name: '关闭', exact: true }).first().click();
  await page
    .getByRole('article', { name: '经营分析协作团队', exact: true })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await page.screenshot({ path: testInfo.outputPath('agent-team-desktop.png') });
  await page.getByRole('tab', { name: '② 流程编排', exact: true }).click();
  await page.getByLabel('节点名称', { exact: false }).fill('确认研判目标');
  await page.getByRole('combobox', { name: '完成条件', exact: true }).selectOption('human');
  await page.screenshot({ path: testInfo.outputPath('agent-flow-desktop.png') });
  await page.getByRole('tab', { name: '③ 运行监控', exact: true }).click();
  await page.getByRole('button', { name: '模拟运行', exact: true }).click();
  await expect(page.getByText('流程等待人工确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.ew-agents-metric').first()).toContainText('已完成');
  await expect(page.getByRole('log')).toContainText('演示已完成');
  await page.screenshot({ path: testInfo.outputPath('agent-monitor-desktop.png') });
  const current = await page.evaluate(() => window.evowork.getStartup());
  expect(current.tasks.length).toBe(startup.tasks.length);
  for (const width of [900, 600, 480]) {
    await resizeWindow(electronApp, width, 800);
    if (width <= 600) {
      const collapse = sidebar.getByRole('button', { name: '折叠侧边栏', exact: true });
      if (await collapse.isVisible()) await collapse.click();
    }
    if (width <= 600) {
      const restore = await page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .boundingBox();
      const breadcrumb = await page.locator('.ew-agents-topline > span').first().boundingBox();
      expect(breadcrumb.x).toBeGreaterThanOrEqual(restore.x + restore.width);
    }
    for (const tab of ['① 组建团队', '② 流程编排', '③ 运行监控']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      const container = await page
        .locator('.ew-agents')
        .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      expect(container.scroll).toBeLessThanOrEqual(container.width + 1);
      await page.screenshot({ path: testInfo.outputPath(`agents-${width}-${tab[0]}.png`) });
    }
  }
  await page.getByRole('button', { name: '返回智能体', exact: true }).click();
  await page
    .getByRole('dialog', { name: '离开当前配置？' })
    .getByRole('button', { name: '放弃并离开', exact: true })
    .click();
  await page.getByRole('button', { name: '新建智能体', exact: true }).click();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('agent-editor-480.png') });
});
