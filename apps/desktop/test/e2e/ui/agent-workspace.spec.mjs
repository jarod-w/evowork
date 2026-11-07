import { horizontalOverflow, resizeWindow } from './assertions.mjs';
import { expect, test } from './fixtures.mjs';

test('智能体后台：本机保存、刷新恢复、编辑与删除，窄窗可用', async ({
  page,
  electronApp,
}, testInfo) => {
  const sidebar = page.getByRole('navigation', { name: '侧边栏', exact: true });
  await sidebar.getByRole('button', { name: '智能体', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: '新建智能体', exact: true }).click();
  await page.getByLabel('智能体名称', { exact: false }).fill('页面审阅助手');
  await page.getByLabel('角色说明', { exact: false }).fill('整理资料');
  await page.getByLabel('工作指令', { exact: false }).fill('先核对来源，再整理事实与结论。');
  await page.getByRole('checkbox', { name: /文档处理/ }).check();
  await page.getByRole('button', { name: '保存智能体', exact: true }).click();
  await expect(page.getByRole('article', { name: '页面审阅助手', exact: true })).toBeVisible();
  const saved = await page.evaluate(() => window.evowork.listAgentWorkspace());
  expect(saved).toHaveLength(1);
  expect(saved[0].skills).toEqual(['documents']);
  await page.reload();
  await page.getByLabel('需求输入').waitFor();
  await sidebar.getByRole('button', { name: '智能体', exact: true }).click();
  await page
    .getByRole('article', { name: '页面审阅助手', exact: true })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await expect(page.getByLabel('工作指令', { exact: false })).toHaveValue(
    '先核对来源，再整理事实与结论。',
  );
  await page.getByLabel('智能体名称', { exact: false }).fill('改名后的助手');
  await page.getByRole('button', { name: '保存智能体', exact: true }).click();
  await expect(page.getByRole('article', { name: '改名后的助手', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /创建多智能体协作/ }).click();
  await page.getByLabel('团队名称', { exact: false }).fill('审阅团队');
  await page.getByRole('button', { name: '保存团队', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存到本机');
  for (const width of [1440, 900, 600, 480]) {
    await resizeWindow(electronApp, width, 900);
    if (width <= 600) {
      const collapse = sidebar.getByRole('button', { name: '折叠侧边栏', exact: true });
      if (await collapse.isVisible()) await collapse.click();
    }
    for (const tab of ['① 组建团队', '② 流程编排', '③ 运行监控']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`agents-backend-${width}.png`) });
  }
  await page.getByRole('button', { name: '返回智能体', exact: true }).click();
  await page.getByRole('button', { name: '管理改名后的助手' }).click();
  await page.getByRole('button', { name: '删除配置', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('article', { name: '改名后的助手', exact: true })).toHaveCount(0);
  const [team] = await page.evaluate(() => window.evowork.listAgentWorkspace());
  expect(team.members.some((m) => m.name === '改名后的助手')).toBe(true);
});
