import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, makeOfficeFixtures, startTaskInWorkspace, test } from './fixtures.mjs';
import {
  scriptFileTools,
  sendFileCommand,
  expectFileAnswer,
  settle,
  selectTask,
  approveFixtureCommand,
} from './file-results-support.mjs';
import { localNodeCommand, writeFileCommand } from './shell-commands.mjs';

const patch = (before, after) =>
  process.platform === 'win32'
    ? localNodeCommand([
        '-e',
        "const fs=require('fs');const p=process.argv[1];const from=Buffer.from(process.argv[2],'hex').toString();const to=Buffer.from(process.argv[3],'hex').toString();const text=fs.readFileSync(p,'utf8');if(!text.includes(from))throw Error('fixture before text missing');fs.writeFileSync(p,text.replace(from,to))",
        'app.ts',
        Buffer.from(before).toString('hex'),
        Buffer.from(after).toString('hex'),
      ])
    : `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: app.ts\n@@\n-${before}\n+${after}\n*** End Patch\nPATCH`;

test('shell 变化可发现，原生工具明确登记和打开，创建修改删除能逐项确认后恢复磁盘', async ({
  page,
  electronApp,
}, testInfo) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  writeFileSync(join(workspace, 'change.txt'), 'original\n');
  writeFileSync(join(workspace, 'remove.txt'), 'restore me\n');
  await scriptFileTools(
    electronApp,
    'FILE-LIFECYCLE',
    [
      {
        tool: 'exec_command',
        args: {
          cmd: [
            writeFileCommand('change.txt', 'changed\n'),
            writeFileCommand('output.txt', 'delivered\n'),
            localNodeCommand(['-e', "require('fs').unlinkSync('remove.txt')"]),
          ].join('\n'),
        },
      },
      { tool: 'list_files', args: {} },
      { tool: 'register_file', args: { path: 'output.txt' } },
      { tool: 'open_file', args: { path: 'output.txt' } },
    ],
    '文件生命周期验收完成。',
  );
  await startTaskInWorkspace(page, electronApp, 'FILE-LIFECYCLE');
  await page.getByRole('button', { name: '允许这一次', exact: true }).click();
  await expectFileAnswer(page, electronApp, '文件生命周期验收完成。');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('region', { name: '文件预览：output.txt' })).toContainText(
    'delivered',
  );
  const taskId = await page.evaluate(
    async () =>
      (await window.evowork.getStartup()).tasks.find((t) => t.title === 'FILE-LIFECYCLE').id,
  );
  const results = await page.evaluate(
    (id) => window.evowork.getTaskResults({ threadId: id }),
    taskId,
  );
  expect(results.workspace.warnings).toEqual([]);
  expect(results.workspace.files.find((f) => f.path.endsWith('output.txt')).source).toBe('task');
  expect(results.workspace.files.find((f) => f.path.endsWith('change.txt')).source).toBe(
    'workspace',
  );
  await page.getByRole('tab', { name: '变更', exact: true }).click();
  await expect(page.locator('.ew-changed-files > li')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('shell-discovery-and-undo.png') });
  for (const name of ['change.txt', 'output.txt', 'remove.txt']) {
    await page
      .locator('.ew-changed-files')
      .getByRole('button', { name: new RegExp(name) })
      .click();
    await page.getByRole('button', { name: '撤销这次变更', exact: true }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(name);
    await confirm.getByRole('button', { name: '确认', exact: true }).click();
    await expect(
      page.locator('.ew-changed-files').getByRole('button', { name: new RegExp(name) }),
    ).toHaveCount(0);
  }
  expect(readFileSync(join(workspace, 'change.txt'), 'utf8')).toBe('original\n');
  expect(readFileSync(join(workspace, 'remove.txt'), 'utf8')).toBe('restore me\n');
  expect(existsSync(join(workspace, 'output.txt'))).toBe(false);
  await expect(page.locator('.ew-changed-files > li')).toHaveCount(0);
  writeFileSync(join(workspace, 'user-only.txt'), 'external user edit');
  const external = page
    .locator('.ew-changed-files')
    .getByRole('button', { name: /user-only\.txt/ });
  await expect(external).toBeVisible();
  await external.click();
  await expect(external).toContainText('来源待确认');
  await expect(page.getByRole('button', { name: '撤销这次变更', exact: true })).toHaveCount(0);
});

test('Office 通过实际本机转换显示 PDF；没有转换器时如实说明正文回退', async ({
  page,
  electronApp,
}, testInfo) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const fixtures = makeOfficeFixtures(testInfo.outputPath('office-source')).filter((f) =>
    /\.(docx|xlsx|pptx)$/.test(f.file),
  );
  for (const fixture of fixtures) copyFileSync(fixture.path, join(workspace, fixture.file));
  await scriptFileTools(
    electronApp,
    'FILE-OFFICE',
    [{ tool: 'open_file', args: { path: fixtures[0].file } }],
    'Office 预览验收完成。',
  );
  await startTaskInWorkspace(page, electronApp, 'FILE-OFFICE');
  await expectFileAnswer(page, electronApp, 'Office 预览验收完成。');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  for (const fixture of fixtures) {
    const preview = await page.evaluate(
      async ({ path }) =>
        window.evowork.readTaskFilePreview({
          threadId: (await window.evowork.getStartup()).tasks.find((t) => t.title === 'FILE-OFFICE')
            .id,
          path,
        }),
      { path: fixture.file },
    );
    if (process.env.EVOWORK_OFFICE_CONVERTER) {
      expect(preview.kind).toBe('pdf');
      expect(preview.content).toMatch(/^data:application\/pdf;base64,JVBER/);
      expect(preview.message).toContain('离线转换');
      expect(preview.pages.length).toBeGreaterThan(0);
      expect(preview.pages[0]).toMatch(/^data:image\/png;base64,iVBOR/);
    } else expect(preview.message).toMatch(/离线转换|不代表原文件排版/);
  }
  await expect(page.getByRole('region', { name: /^文件预览：/ })).toContainText(
    process.env.EVOWORK_OFFICE_CONVERTER ? '离线转换' : /离线转换|不代表原文件排版/,
  );
  if (process.env.EVOWORK_OFFICE_CONVERTER) {
    const image = page.getByRole('region', { name: /^文件预览：/ }).getByRole('img');
    await expect
      .poll(() => image.evaluate((img) => img.complete && img.naturalWidth > 100))
      .toBe(true);
    await expect(page.getByRole('region', { name: /^文件预览：/ }).locator('iframe')).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(image).toHaveAttribute('alt', /第 2 页/);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
  }
  await page.screenshot({ path: testInfo.outputPath('office-layout-preview.png') });
});

test('代码重复修改展示任务和回合完整净差异，默认页签、关闭选择与重开历史正确', async ({
  page,
  electronApp,
}, testInfo) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  writeFileSync(join(workspace, 'app.ts'), "const title = 'before';\nconst keep = true;\n");
  const marker = 'FILE-RESULTS-CODE';
  await electronApp.evaluate(
    (_, { marker, commands }) => {
      const { gateway } = globalThis.__evoworkE2E;
      commands.forEach((cmd, index) =>
        gateway.scriptWhen(
          `code-${index}`,
          (request) =>
            request.text.includes(marker) &&
            request.calls.filter((name) => name === 'exec_command').length === index,
          { tool: 'exec_command', args: { cmd } },
        ),
      );
      gateway.scriptWhen('code-done', (request) => request.text.includes(marker), {
        kind: 'text',
        text: '代码修改完成。',
      });
    },
    {
      marker,
      commands: [
        patch("const title = 'before';", "const title = 'middle';"),
        patch("const title = 'middle';", "const title = 'after';"),
      ],
    },
  );
  await startTaskInWorkspace(page, electronApp, marker);
  await settle(page, '代码修改完成。');
  await expect(page.getByText('代码修改完成。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByRole('tab', { name: '变更', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.ew-changed-files > li')).toHaveCount(1);
  const diff = page.locator('.ew-diff-body');
  await expect(diff).toContainText("-const title = 'before';");
  await expect(diff).not.toContainText('middle');
  await expect(diff).toContainText("+const title = 'after';");
  await expect(page.getByRole('tab', { name: '并排', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '本回合', exact: true }).click();
  await expect(page.locator('.ew-changed-files > li')).toHaveCount(1);
  await expect(diff).toContainText("-const title = 'before';");
  await expect(diff).toContainText("+const title = 'after';");
  await expect(diff).not.toContainText('middle');
  await page.screenshot({ path: testInfo.outputPath('code-net-diff.png') });

  await page.getByRole('button', { name: '关闭结果', exact: true }).click();
  await sendFileCommand(
    page,
    electronApp,
    '再修改一次',
    patch("const title = 'after';", "const title = 'final';"),
  );
  await expect
    .poll(() => readFileSync(join(workspace, 'app.ts'), 'utf8'))
    .toContain("const title = 'final';");
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await expect(page.locator('.ew-result-pane')).toHaveCount(0);
  await page.getByRole('button', { name: '打开结果', exact: true }).click();
  await expect(page.getByRole('tab', { name: '变更', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: '本任务全部', exact: true }).click();
  await expect(diff).toContainText("-const title = 'before';");
  await expect(diff).toContainText("+const title = 'final';");
  await page.reload();
  await page
    .getByRole('navigation', { name: '侧边栏' })
    .getByRole('button', { name: new RegExp(`^${marker}`) })
    .first()
    .click();
  await expect(page.getByRole('tab', { name: '变更', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.ew-changed-files > li')).toHaveCount(1);
  await expect(diff).toContainText("-const title = 'before';");
  await expect(diff).toContainText("+const title = 'final';");
  await page.screenshot({ path: testInfo.outputPath('code-history-restored.png') });
});

test('两个真实任务共用工作目录并发生成，上报脚本携带各自任务身份', async ({
  page,
  electronApp,
}) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const mark = resolve('plugins/skills/documents/container_tools/mark_artifact.mjs');
  const home = await electronApp.evaluate(() => globalThis.__evoworkE2E.home);
  const gate = join(home, 'fixture-first-mark-ready');
  const wait = localNodeCommand([
    '-e',
    "const fs=require('fs');const until=Date.now()+15000;while(!fs.existsSync(process.argv[1])){if(Date.now()>until)throw Error('fixture gate timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}",
    gate,
  ]);
  const outputs = ['first', 'second'].map((name, index) => ({
    marker: `FILE-RESULTS-${name}`,
    path: join(workspace, `${name}.md`),
    cmd: [
      writeFileCommand(join(workspace, `${name}.md`), name),
      ...(index === 0 ? [wait] : []),
      localNodeCommand([
        mark,
        '--operation-kind',
        'create',
        '--output-format',
        'md',
        '--path',
        join(workspace, `${name}.md`),
      ]),
    ].join('\n'),
  }));
  await electronApp.evaluate((_, outputs) => {
    const { gateway } = globalThis.__evoworkE2E;
    outputs.forEach((output, index) =>
      gateway.scriptWhen(
        output.marker,
        (request) =>
          request.text.includes(output.marker) && !request.calls.includes('exec_command'),
        { tool: 'exec_command', args: { cmd: output.cmd } },
        index === 0 ? { ready: ({ matched }) => matched(outputs[1].marker) } : {},
      ),
    );
  }, outputs);
  await startTaskInWorkspace(page, electronApp, outputs[0].marker);
  await expect
    .poll(() =>
      electronApp.evaluate(
        (_, marker) => Boolean(globalThis.__evoworkE2E.gateway.matchedBody(marker)),
        outputs[0].marker,
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await startTaskInWorkspace(page, electronApp, outputs[1].marker);
  await approveFixtureCommand(page, () => existsSync(outputs[1].path));
  await selectTask(page, outputs[0].marker);
  await approveFixtureCommand(page, () => existsSync(outputs[0].path));
  await selectTask(page, outputs[1].marker);
  await expect(page.getByRole('heading', { name: outputs[1].marker, exact: true })).toBeVisible();
  // First task reports while the second task is active, even when Windows asks
  // for command approval. Never infer ownership from the active conversation.
  writeFileSync(gate, 'ready');
  await expect
    .poll(
      async () => {
        const { tasks } = await page.evaluate(() => window.evowork.getStartup());
        return Promise.all(
          outputs.map(async (output) => {
            const task = tasks.find((entry) => entry.title === output.marker);
            if (!task) return [];
            return (
              await page.evaluate((id) => window.evowork.getTaskResults({ threadId: id }), task.id)
            ).artifacts.map((artifact) => artifact.name);
          }),
        );
      },
      { timeout: 60_000 },
    )
    .toEqual([['first.md'], ['second.md']]);
});
