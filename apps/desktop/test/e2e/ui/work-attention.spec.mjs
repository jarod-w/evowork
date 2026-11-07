/**
 * 跨任务待办、有历史后的首页、结果区验收。
 * 假网关 + 真窗口。不依赖厂商模型。
 */
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { localNodeCommand, writeFileCommand } from './shell-commands.mjs';
import { expectFileAnswer, idle, scriptFileTools, settle } from './file-results-support.mjs';

test('有任务后首页给出状态，待批准能从侧栏点回去，产物直接进入结果预览', async ({
  page,
  electronApp,
}) => {
  await expect(page.getByRole('heading', { name: '有什么可以帮忙的？' })).toBeVisible();
  await expect(page.getByRole('region', { name: '当前工作' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '待处理' })).toHaveCount(0);

  await scriptFileTools(
    electronApp,
    'WORK-ACCEPT',
    [
      { tool: 'exec_command', args: { cmd: writeFileCommand('output.md', '# delivered\n') } },
      { tool: 'register_file', args: { path: 'output.md' } },
    ],
    '验收原型已交付。',
  );
  await startTaskInWorkspace(page, electronApp, 'WORK-ACCEPT');
  await settle(page, '验收原型已交付。', 20_000);
  await expectFileAnswer(page, electronApp, '验收原型已交付。');
  await idle(page);

  await expect(page.getByRole('tab', { name: '产物', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: '验收', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '浏览器', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '文件预览：output.md' })).toContainText(
    'delivered',
  );

  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByRole('region', { name: '当前工作' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '有什么可以帮忙的？' })).toBeVisible();

  await electronApp.evaluate(
    (_, cmd) => {
      globalThis.__evoworkE2E.gateway.scriptNext({
        tool: 'exec_command',
        args: {
          cmd,
          sandbox_permissions: 'require_escalated',
          justification: '确认离开这条任务后，待批准仍出现在侧栏',
        },
      });
    },
    localNodeCommand(['-e', "process.stdout.write('held')"]),
  );
  await page.getByLabel('需求输入').fill('WORK-WAIT 等我批准');
  await page.getByRole('button', { name: '发送' }).click();
  const card = page.getByLabel('需要你确认');
  await expect(card).toBeVisible();

  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const home = page.getByRole('region', { name: '当前工作' });
  await expect(home).toBeVisible();
  await expect(home.getByRole('button', { name: /等你处理/ })).toBeEnabled();
  const queue = page.getByRole('region', { name: '待处理' });
  await expect(queue).toBeVisible();
  await queue.getByRole('button', { name: /待批准/ }).click();
  await expect(page.getByLabel('需要你确认')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'WORK-WAIT 等我批准' })).toBeVisible();
});
