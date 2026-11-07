import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { scriptFileTools, settle } from './file-results-support.mjs';

test('真实堆叠提示不遮挡结果、任务菜单与发送，关闭仍有效', async ({ page, electronApp }, info) => {
  const initial = 'TOAST-INITIAL-TASK';
  const marker = 'TOAST-COMPOSER-VISIBLE';
  const input = page.getByLabel('需求输入');
  await scriptFileTools(
    electronApp,
    initial,
    [
      {
        tool: 'exec_command',
        args: {
          cmd:
            process.platform === 'win32'
              ? "[System.IO.File]::WriteAllText('toast-result.txt', 'READY')"
              : 'printf READY > toast-result.txt',
          sandbox_permissions: 'require_escalated',
          justification: '通知布局回归写入测试工作目录',
        },
      },
      { tool: 'register_file', args: { path: 'toast-result.txt' } },
      { tool: 'open_file', args: { path: 'toast-result.txt' } },
    ],
    initial + ' DONE',
  );
  await startTaskInWorkspace(page, electronApp, initial);
  await settle(page, initial + ' DONE');
  await expect(page.getByRole('main', { name: '对话区' })).toBeVisible();
  const startup = await page.evaluate(() => window.evowork.getStartup());
  const task = [...startup.tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  expect(task?.id).toBeTruthy();
  await expect
    .poll(async () => {
      const h = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
      return h.turns.at(-1)?.status;
    })
    .toBe('completed');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  const initialHistory = await page.evaluate(
    (id) => window.evowork.openTask({ threadId: id }),
    task.id,
  );
  const fileCalls = initialHistory.items.filter(
    (item) => item.type === 'mcpToolCall' && item.server === 'workspace_files',
  );
  expect(fileCalls).toHaveLength(2);
  for (const call of fileCalls) {
    expect(call.status).toBe('completed');
    expect(call.error ?? null).toBeNull();
    expect(call.result?.isError ?? false).toBe(false);
  }
  await electronApp.evaluate((_, id) => {
    const controls = globalThis.__evoworkE2E;
    controls.toastOriginalList = controls.host.actions.listQueuedInputs;
    controls.host.actions.listQueuedInputs = async () => {
      throw new Error('Controlled queue refresh failure');
    };
    for (let i = 0; i < 3; i++)
      controls.window.webContents.send('evowork:ui-event', { type: 'queue-changed', taskId: id });
  }, task.id);
  const stack = page.locator('.ew-toast-stack');
  try {
    await expect(stack.locator('.ew-toast[data-tone="danger"]')).toHaveCount(3);
    expect(await stack.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  } finally {
    await electronApp.evaluate(() => {
      const c = globalThis.__evoworkE2E;
      c.host.actions.listQueuedInputs = c.toastOriginalList;
      delete c.toastOriginalList;
    });
  }
  const open = page.getByRole('button', { name: '打开结果', exact: true });
  if (await open.count()) await open.click({ timeout: 5000 });
  const changes = page.getByRole('tab', { name: '变更', exact: true });
  const nonoverlap = async (control) => {
    const a = await stack.boundingBox(),
      b = await control.boundingBox();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(
      a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y,
      '通知必须与操作区域在视觉上分开',
    ).toBe(true);
  };
  await nonoverlap(changes);
  await changes.click({ timeout: 5000 });
  await expect(changes).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '任务更多操作', exact: true }).click({ timeout: 5000 });
  await page.getByRole('menuitem', { name: '提炼为技能', exact: true }).click({ timeout: 5000 });
  const dialog = page.getByRole('dialog', { name: '从本任务提炼技能' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await stack.getByRole('button', { name: '关闭提示' }).first().click({ timeout: 5000 });
  await expect(stack.locator('.ew-toast')).toHaveCount(2);
  await input.fill(marker);
  const send = page.getByRole('button', { name: '发送', exact: true });
  await nonoverlap(send);
  await page.screenshot({ path: info.outputPath('notifications-reserve-layout.png') });
  await send.click({ timeout: 5000 });
  await expect(input).toHaveValue('');
  await expect
    .poll(async () => {
      const h = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
      return JSON.stringify(h.items.filter((i) => i.type === 'userMessage'));
    })
    .toContain(marker);
});
