import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

test('同一次命令审批在用户等待时不重复堆积，拒绝后不执行', async ({ page, electronApp }, info) => {
  const marker = 'APPROVAL-PENDING-ONCE';
  await electronApp.evaluate((_, marker) => {
    globalThis.__evoworkE2E.gateway.scriptWhen(
      marker,
      (r) => r.text.includes(marker) && r.calls.length === 0,
      {
        tool: 'exec_command',
        args: {
          cmd: 'echo APPROVAL-PENDING-ONCE',
          sandbox_permissions: 'require_escalated',
          justification: '等待用户决定，未获批准不能执行',
        },
      },
    );
    globalThis.__evoworkE2E.gateway.scriptWhen(marker + '-done', (r) => r.text.includes(marker), {
      kind: 'text',
      text: '已拒绝，未执行',
    });
  }, marker);
  await startTaskInWorkspace(page, electronApp, marker);
  const cards = page.getByLabel('需要你确认');
  await expect(cards.first()).toBeVisible();
  const startup = await page.evaluate(() => window.evowork.getStartup());
  const task = startup.tasks.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  for (let read = 0; read < 3; read++)
    await page.evaluate((threadId) => window.evowork.openTask({ threadId }), task.id);
  await page.waitForTimeout(6000);
  const pending = await electronApp.evaluate(() => {
    const entries = globalThis.__evoworkE2E.host.adapter.approvals.pendingList();
    const groups = new Map();
    for (const a of entries) {
      const p = a.params;
      const key = JSON.stringify([a.threadId, a.turnId, a.itemId, p.approvalId, p.command, p.cwd]);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return {
      total: entries.length,
      unique: groups.size,
      maxCopies: Math.max(0, ...groups.values()),
    };
  });
  await info.attach('pending-approval-counts', {
    body: JSON.stringify(pending),
    contentType: 'application/json',
  });
  expect(pending.total).toBeGreaterThan(0);
  expect(pending.maxCopies, '同一工具调用只能有一张未决审批卡').toBe(1);
  while (await cards.count())
    await cards.first().getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  const history = await page.evaluate((threadId) => window.evowork.openTask({ threadId }), task.id);
  expect(
    history.items.filter((i) => i.type === 'commandExecution' && i.exitCode === 0),
  ).toHaveLength(0);
});
