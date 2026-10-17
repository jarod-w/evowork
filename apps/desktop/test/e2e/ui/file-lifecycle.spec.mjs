import {
  readFileSync,
  writeFileSync,
  symlinkSync,
  openSync,
  closeSync,
  ftruncateSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import {
  changes,
  results,
  revertSelected,
  scriptFileTools,
  selectTask,
  settle,
  taskId,
  quote,
} from './file-results-support.mjs';

async function commandTask(page, electronApp, marker, cmd) {
  await scriptFileTools(
    electronApp,
    marker,
    [{ tool: 'exec_command', args: { cmd } }],
    marker + ' DONE',
  );
  await startTaskInWorkspace(page, electronApp, marker);
  const id = await taskId(page, marker);
  await settle(page, marker + ' DONE');
  return id;
}

test('撤销可取消；刷新后副本仍可用；本回合和任务范围恢复到不同起点', async ({
  page,
  electronApp,
}, info) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const path = join(root, 'state.txt');
  writeFileSync(path, 'original\n');
  const marker = 'FILE-SCOPES';
  const id = await commandTask(page, electronApp, marker, "printf 'middle\\n' > state.txt");
  await changes(page);
  await page.getByRole('button', { name: '撤销这次变更', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(readFileSync(path, 'utf8')).toBe('middle\n');
  await page.reload();
  await selectTask(page, marker);
  await changes(page);
  await expect(page.getByRole('button', { name: '撤销这次变更', exact: true })).toBeVisible();
  await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.scriptNext({
      tool: 'exec_command',
      args: { cmd: "printf 'final\\n' > state.txt" },
    }),
  );
  await page.getByLabel('需求输入').fill('第二回合只修改 state.txt');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await settle(page, /^E2E response/);
  await changes(page);
  await page.getByRole('tab', { name: '本回合', exact: true }).click();
  await expect(page.locator('.ew-diff-body')).toContainText('-middle');
  await expect(page.locator('.ew-diff-body')).not.toContainText('original');
  await revertSelected(page);
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('middle\n');
  await page.getByRole('tab', { name: '本任务全部', exact: true }).click();
  await expect(page.locator('.ew-diff-body')).toContainText('-original');
  await expect(page.locator('.ew-diff-body')).toContainText('+middle');
  await revertSelected(page);
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('original\n');
  expect((await results(page, id)).workspace.thread).toEqual([]);
  await page.screenshot({ path: info.outputPath('two-scopes-restored.png') });
});

test('回合之间的用户编辑禁止按任务起点覆盖，本回合仍能恢复到用户版本', async ({
  page,
  electronApp,
}) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace),
    path = join(root, 'gap.txt');
  writeFileSync(path, 'original');
  await commandTask(page, electronApp, 'FILE-GAP', 'printf first-agent > gap.txt');
  writeFileSync(path, 'user-between-turns');
  await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.scriptNext({
      tool: 'exec_command',
      args: { cmd: 'printf second-agent > gap.txt' },
    }),
  );
  await page.getByLabel('需求输入').fill('修改 gap.txt');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await settle(page, /^E2E response/);
  await changes(page);
  await page.getByRole('tab', { name: '本任务全部', exact: true }).click();
  await expect(page.getByText(/回合之间存在外部文件改动/)).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销这次变更', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '本回合', exact: true }).click();
  await expect(page.locator('.ew-diff-body')).toContainText('-user-between-turns');
  await revertSelected(page);
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('user-between-turns');
});

test('真实MCP分页发现105个文件不泄露正文；助手交付措辞不会代替打开事件', async ({
  page,
  electronApp,
}) => {
  await scriptFileTools(
    electronApp,
    'FILE-PAGING',
    [
      {
        tool: 'exec_command',
        args: {
          cmd: 'node -e \'const fs=require("fs");for(let i=0;i<105;i++)fs.writeFileSync(`file-${String(i).padStart(3,"0")}.txt`,"BODY-PRIVATE-DATA")\'',
        },
      },
      { tool: 'list_files', args: {} },
      { tool: 'list_files', args: { cursor: '100' } },
    ],
    '已完成，已生成，请查看预览。',
  );
  await startTaskInWorkspace(page, electronApp, 'FILE-PAGING');
  const id = await taskId(page, 'FILE-PAGING');
  await settle(page, '已完成，已生成，请查看预览。');
  const history = await page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
  const lists = history.items
    .filter((i) => i.type === 'mcpToolCall' && i.tool === 'list_files')
    .map((i) => JSON.parse(i.result.content[0].text));
  expect(lists.map((list) => list.files.length)).toEqual([100, 5]);
  expect(lists[0].nextCursor).toBe('100');
  expect(lists[1].nextCursor).toBeNull();
  expect(JSON.stringify(lists)).not.toContain('BODY-PRIVATE-DATA');
  expect(new Set(lists.flatMap((list) => list.files.map((f) => f.path))).size).toBe(105);
  await expect(page.getByRole('region', { name: /^文件预览：/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '变更', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.ew-changed-files > li')).toHaveCount(105);
});

test('技能先上报后创建和编辑，最新落盘版本始终归实际任务且不生成虚假首版', async ({
  page,
  electronApp,
}) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace),
    path = join(root, 'delayed-report.md');
  const mark = resolve('plugins/skills/documents/container_tools/mark_artifact.mjs');
  const cmd = (operation) =>
    `node ${quote(mark)} --operation-kind ${operation} --output-format md --path ${quote(path)}\nsleep 1.2\nprintf ${operation === 'create' ? 'FIRST' : 'SECOND'} > ${quote(path)}`;
  const id = await commandTask(page, electronApp, 'FILE-DELAY', cmd('create'));
  await expect
    .poll(async () => (await results(page, id)).artifacts.map((a) => a.version))
    .toEqual([1]);
  expect(readFileSync(path, 'utf8')).toBe('FIRST');
  await electronApp.evaluate(
    (_, cmd) => globalThis.__evoworkE2E.gateway.scriptNext({ tool: 'exec_command', args: { cmd } }),
    cmd('edit'),
  );
  await page.getByLabel('需求输入').fill('编辑刚才生成的报告');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await settle(page, /^E2E response/);
  await expect
    .poll(async () => (await results(page, id)).artifacts.map((a) => a.version))
    .toEqual([2]);
  expect(readFileSync(path, 'utf8')).toBe('SECOND');
  expect(
    (await results(page, id)).workspace.files.find((f) => f.path.endsWith('delayed-report.md'))
      .source,
  ).toBe('task');
});

test('确认期间发生外部修改就拒绝覆盖；撤销其他文件不能洗掉这个冲突', async ({
  page,
  electronApp,
}, info) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  for (const name of ['one.txt', 'two.txt']) writeFileSync(join(root, name), 'original');
  const id = await commandTask(
    page,
    electronApp,
    'FILE-CONFLICT',
    'printf agent > one.txt\nprintf agent > two.txt',
  );
  await changes(page);
  await page
    .locator('.ew-changed-files')
    .getByRole('button', { name: /one.txt/ })
    .click();
  await page.getByRole('button', { name: '撤销这次变更', exact: true }).click();
  writeFileSync(join(root, 'one.txt'), 'external user work');
  await expect
    .poll(
      async () =>
        (await results(page, id)).workspace.thread.find((f) => f.path.endsWith('one.txt'))
          .reversible,
    )
    .toBe(false);
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText(/文件状态已改变|其他操作修改/)).toBeVisible();
  expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('external user work');
  await page
    .locator('.ew-changed-files')
    .getByRole('button', { name: /two.txt/ })
    .click();
  await revertSelected(page);
  await expect.poll(() => readFileSync(join(root, 'two.txt'), 'utf8')).toBe('original');
  await page
    .locator('.ew-changed-files')
    .getByRole('button', { name: /one.txt/ })
    .click();
  await expect(page.getByRole('button', { name: '撤销这次变更', exact: true })).toHaveCount(0);
  expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('external user work');
  await page.screenshot({ path: info.outputPath('external-edit-preserved.png') });
});

test('会话回滚明确不动磁盘；二进制和超过64KB的等长修改仍能实际恢复', async ({
  page,
  electronApp,
}, info) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const original = Buffer.from([0, 1, 2, 3, 255]);
  writeFileSync(join(root, 'data.bin'), original);
  writeFileSync(join(root, 'long.txt'), 'x'.repeat(70000) + 'before');
  await commandTask(
    page,
    electronApp,
    'FILE-BINARY',
    'node -e \'const fs=require("fs"); fs.writeFileSync("data.bin",Buffer.from([0,9,8,7,255])); fs.writeFileSync("long.txt","x".repeat(70000)+"after!")\'',
  );
  await changes(page);
  await page
    .locator('.ew-changed-files')
    .getByRole('button', { name: /data.bin/ })
    .click();
  await expect(page.locator('.ew-diff-body')).toContainText('二进制');
  await page.getByRole('button', { name: '回滚到这个回合', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('磁盘上的文件保持现在的样子');
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('对话已回滚；磁盘文件没有改动。')).toBeVisible();
  expect(readFileSync(join(root, 'data.bin'))).toEqual(Buffer.from([0, 9, 8, 7, 255]));
  await revertSelected(page);
  await expect.poll(() => readFileSync(join(root, 'data.bin')).equals(original)).toBe(true);
  await page
    .locator('.ew-changed-files')
    .getByRole('button', { name: /long.txt/ })
    .click();
  await expect(page.locator('.ew-diff-body')).toContainText('after!');
  await revertSelected(page);
  await expect
    .poll(() => readFileSync(join(root, 'long.txt'), 'utf8').endsWith('before'))
    .toBe(true);
  await page.screenshot({ path: info.outputPath('binary-restored.png') });
});

test('同工作目录另一任务运行时禁止撤销，结束后当前页面恢复撤销入口', async ({
  page,
  electronApp,
}) => {
  await commandTask(page, electronApp, 'FILE-OWNER', 'printf generated > shared.txt');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await startTaskInWorkspace(page, electronApp, 'FILE-BUSY EVOWORK-UI-HOLD');
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.turnClaimed()))
    .toBe(true);
  await selectTask(page, 'FILE-OWNER');
  await changes(page);
  await expect(page.getByRole('button', { name: '撤销这次变更', exact: true })).toHaveCount(0);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseClaimedTurn());
  await expect(page.getByRole('button', { name: '撤销这次变更', exact: true })).toBeVisible();
});

test('后台任务明确打开不会抢当前任务，切回后显示对应文件', async ({ page, electronApp }, info) => {
  await electronApp.evaluate(() => {
    globalThis.__fileOpenGate = false;
    const { gateway } = globalThis.__evoworkE2E;
    gateway.scriptWhen(
      'background-write',
      (v) => v.text.includes('FILE-BACKGROUND') && v.calls.length === 0,
      { tool: 'exec_command', args: { cmd: 'printf background-content > background.txt' } },
    );
    gateway.scriptWhen(
      'background-open',
      (v) => v.text.includes('FILE-BACKGROUND') && v.calls.length === 1,
      {
        tool: (body) => {
          const flatten = (list) => list.flatMap((t) => (t.tools ? flatten(t.tools) : [t.name]));
          return flatten(JSON.parse(body).tools).find((n) => n?.endsWith('open_file'));
        },
        args: { path: 'background.txt' },
      },
      { ready: () => globalThis.__fileOpenGate },
    );
    gateway.scriptWhen('background-done', (v) => v.text.includes('FILE-BACKGROUND'), {
      kind: 'text',
      text: 'BACKGROUND DONE',
    });
  });
  await startTaskInWorkspace(page, electronApp, 'FILE-BACKGROUND');
  await expect
    .poll(() =>
      electronApp.evaluate(() =>
        Boolean(globalThis.__evoworkE2E.gateway.matchedBody('background-open')),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await startTaskInWorkspace(page, electronApp, 'FILE-FOREGROUND');
  await settle(page, /^E2E response/);
  await electronApp.evaluate(() => {
    globalThis.__fileOpenGate = true;
  });
  await expect
    .poll(async () => {
      const id = (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
        (t) => t.title === 'FILE-BACKGROUND',
      ).id;
      return (
        await page.evaluate((threadId) => window.evowork.openTask({ threadId }), id)
      ).items.some((i) => i.type === 'agentMessage' && i.text === 'BACKGROUND DONE');
    })
    .toBe(true);
  await expect(page.getByRole('heading', { name: 'FILE-FOREGROUND', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '文件预览：background.txt' })).toHaveCount(0);
  await selectTask(page, 'FILE-BACKGROUND');
  await expect(page.getByRole('region', { name: '文件预览：background.txt' })).toContainText(
    'background-content',
  );
  await page.screenshot({ path: info.outputPath('background-open-scoped.png') });
});

test('真实MCP拒绝缺失/目录/穿越/软链路径，未打开外部文件或错误认领', async ({
  page,
  electronApp,
}) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const outside = join(dirname(root), 'outside-sentinel.txt');
  writeFileSync(outside, 'OUTSIDE PRIVATE SENTINEL');
  symlinkSync(outside, join(root, 'link.txt'));
  await scriptFileTools(
    electronApp,
    'FILE-DENY',
    [
      { tool: 'open_file', args: { path: '../outside-sentinel.txt' } },
      { tool: 'open_file', args: { path: 'link.txt' } },
      { tool: 'open_file', args: { path: 'missing.txt' } },
      { tool: 'register_file', args: { path: '.' } },
    ],
    'DENIED PATHS DONE',
  );
  await startTaskInWorkspace(page, electronApp, 'FILE-DENY');
  const id = await taskId(page, 'FILE-DENY');
  await settle(page, 'DENIED PATHS DONE');
  const history = await page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
  const calls = history.items.filter((i) => i.type === 'mcpToolCall');
  expect(calls).toHaveLength(4);
  for (const call of calls)
    expect(
      call.result?.isError || call.error || JSON.stringify(call.result).includes('error'),
    ).toBeTruthy();
  expect(
    JSON.stringify(history.items.filter((i) => i.type === 'mcpToolCall').map((i) => i.result)),
  ).not.toContain('OUTSIDE PRIVATE SENTINEL');
  expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE PRIVATE SENTINEL');
  await expect(page.getByRole('region', { name: /^文件预览：/ })).toHaveCount(0);
  expect((await results(page, id)).artifacts).toEqual([]);
});

test('超出单文件快照上限会提示限制，不显示虚假的撤销按钮', async ({ page, electronApp }, info) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const fd = openSync(join(root, 'oversized.bin'), 'w');
  ftruncateSync(fd, 33 * 1024 * 1024);
  closeSync(fd);
  await commandTask(page, electronApp, 'FILE-QUOTA', 'printf safe > small.txt');
  await changes(page);
  await expect(page.getByText(/较大文件仅比较元数据/)).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销这次变更', exact: true })).toHaveCount(0);
  expect(readFileSync(join(root, 'small.txt'), 'utf8')).toBe('safe');
  await page.screenshot({ path: info.outputPath('quota-visible.png') });
});
