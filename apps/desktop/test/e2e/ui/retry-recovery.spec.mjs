import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from './command-approvals.mjs';
import { expect, startTaskInWorkspace } from './fixtures.mjs';
import { localNodeCommand } from './shell-commands.mjs';

test.use({ desktopEnv: { EVOWORK_UI_NATIVE_RETRIES: '2' } });

async function currentTask(page, marker) {
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  return tasks.find((task) => task.title?.includes(marker));
}

const history = (page, id) =>
  page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);

test('自动重连丢弃失败尝试的预览，保留已经交付的进度与最终正文', async ({ page, electronApp }) => {
  const marker = 'RECOVERY-STREAM';
  const progress = '先确认文件可读。';
  const fragment = '文件内容已核';
  const answer = '文件内容已核对，结果无误。';
  const cmd = localNodeCommand(['-e', "console.log('readable')"]);
  await electronApp.evaluate(
    (_, { marker, progress, fragment, answer, cmd }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      const match = (view) => view.text.includes(marker);
      gateway.scriptWhen('progress', match, {
        preamble: progress,
        tool: 'exec_command',
        args: { cmd },
      });
      gateway.scriptWhen('stream-break', match, {
        kind: 'hold',
        text: fragment,
        failOnRelease: true,
      });
      gateway.scriptWhen('reconnected', match, { kind: 'text', text: answer });
    },
    { marker, progress, fragment, answer, cmd },
  );
  await startTaskInWorkspace(page, electronApp, marker + ' 核对文件');
  await expect(page.getByText(fragment, { exact: true })).toBeVisible();
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByText(fragment, { exact: true })).toHaveCount(0, { timeout: 2500 });
  await expect(page.getByText(progress, { exact: true })).toBeVisible();
  const current = await currentTask(page, marker);
  expect(
    (await history(page, current.id)).items
      .filter((item) => item.type === 'agentMessage')
      .map((item) => item.text),
  ).toEqual([progress, answer]);
  await page.reload();
  await page.getByRole('button', { name: current.title, exact: true }).click();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await expect(page.getByText(fragment, { exact: true })).toHaveCount(0);
});

test('写入成功后总结失败，点击重试只请求恢复，不重提原来的写入需求', async ({
  page,
  electronApp,
}) => {
  const marker = 'RECOVERY-WRITE';
  const prompt = marker + ' 向文件追加一行';
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const path = join(workspace, 'retry-audit.txt');
  const cmd = localNodeCommand([
    '-e',
    "require('node:fs').appendFileSync('retry-audit.txt','audit\\n')",
  ]);
  await electronApp.evaluate(
    (_, { marker, prompt, cmd }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      const match = (view) => view.text.includes(marker);
      gateway.scriptWhen('write-once', match, { tool: 'exec_command', args: { cmd } });
      gateway.scriptWhen('summary-fails', match, {
        kind: 'fail',
        code: 'invalid_prompt',
        text: '总结失败',
      });
      gateway.scriptWhen('repeat-write-on-replay', (view) => view.text.split(prompt).length >= 3, {
        tool: 'exec_command',
        args: { cmd },
      });
      gateway.scriptWhen('recover-reply', match, {
        kind: 'text',
        text: '已经核对文件中的一行记录。',
      });
    },
    { marker, prompt, cmd },
  );
  await startTaskInWorkspace(page, electronApp, prompt);
  const card = page.getByRole('alert', { name: '回合失败' });
  await expect(card).toBeVisible();
  expect(readFileSync(path, 'utf8')).toBe('audit\n');
  await page.reload();
  const current = await currentTask(page, marker);
  await page.getByRole('button', { name: current.title, exact: true }).click();
  await card.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('已经核对文件中的一行记录。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  expect(readFileSync(path, 'utf8')).toBe('audit\n');
  const result = await history(page, current.id);
  expect(result.turns.map((item) => item.status)).toEqual(['failed', 'completed']);
  const users = result.items.filter((item) => item.type === 'userMessage');
  expect(users[0].content[0].text).toBe(prompt);
  expect(users[1].content[0].text).toContain('只执行剩余步骤');
  expect(result.items.filter((item) => item.type === 'commandExecution')).toHaveLength(1);
});
