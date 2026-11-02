import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { approveTaskTreeCommandOnce } from './task-tree-approvals.mjs';

test.use({ registerModels: true });
test('子代理命令从子任务时间线批准，回到根任务后汇总并保留唯一审批', async ({
  page,
  electronApp,
}, info) => {
  const marker = 'TREE-APPROVAL-ROOT';
  const child = 'TREE-APPROVAL-CHILD';
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  await electronApp.evaluate(
    (_, { marker, child }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      gateway.scriptWhen(
        'tree-root-spawn',
        (r) => r.text.includes(marker) && r.calls.length === 0,
        {
          tool: 'spawn_agent',
          args: { task_name: 'writer', message: child, fork_turns: 'none' },
        },
      );
      gateway.scriptWhen('tree-root-wait', (r) => r.text.includes(marker) && r.calls.length === 1, {
        tool: 'wait_agent',
        args: { timeout_ms: 60000 },
      });
      gateway.scriptWhen(
        'tree-child-command',
        (r) => r.text.includes(child) && !r.calls.includes('spawn_agent') && r.calls.length === 0,
        {
          tool: 'exec_command',
          args: {
            cmd:
              process.platform === 'win32'
                ? "[System.IO.File]::WriteAllText('child-approved.txt', 'TREE_OK')"
                : 'printf TREE_OK > child-approved.txt',
            sandbox_permissions: 'require_escalated',
            justification: '本测试授权子任务写入当前工作目录',
          },
        },
      );
      gateway.scriptWhen(
        'tree-child-done',
        (r) => r.text.includes(child) && !r.calls.includes('spawn_agent'),
        { kind: 'text', text: 'CHILD_FINISHED' },
      );
      gateway.scriptWhen('tree-root-done', (r) => r.text.includes(marker), {
        kind: 'text',
        text: 'ROOT_FINISHED',
      });
    },
    { marker, child },
  );
  await startTaskInWorkspace(page, electronApp, marker);
  try {
    await expect
      .poll(
        async () => {
          await approveTaskTreeCommandOnce(page);
          return existsSync(join(root, 'child-approved.txt'));
        },
        { timeout: 15000, intervals: [200, 500] },
      )
      .toBe(true);
    expect(readFileSync(join(root, 'child-approved.txt'), 'utf8')).toBe('TREE_OK');
    await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible();
    await expect(page.getByText('ROOT_FINISHED', { exact: true })).toBeVisible({ timeout: 75000 });
    const pending = await electronApp.evaluate(
      () => globalThis.__evoworkE2E.host.adapter.approvals.pendingList().length,
    );
    expect(pending).toBe(0);
  } finally {
    const startup = await page.evaluate(() => window.evowork.getStartup());
    const task = startup.tasks.find((t) => !t.parentThreadId);
    const history = task
      ? await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id)
      : null;
    const rules = await electronApp.evaluate(() =>
      [
        'tree-root-spawn',
        'tree-root-wait',
        'tree-child-command',
        'tree-child-done',
        'tree-root-done',
      ].map((name) => ({ name, matched: !!globalThis.__evoworkE2E.gateway.matchedBody(name) })),
    );
    const children = task
      ? await page.evaluate((id) => window.evowork.listSubtasks({ threadId: id }), task.id)
      : [];
    const pending = await electronApp.evaluate(() =>
      globalThis.__evoworkE2E.host.adapter.approvals
        .pendingList()
        .map((a) => ({ threadId: a.threadId, kind: a.kind })),
    );
    await info.attach('tree-history', {
      body: JSON.stringify({ history, rules, children, pending }),
      contentType: 'application/json',
    });
  }
});
