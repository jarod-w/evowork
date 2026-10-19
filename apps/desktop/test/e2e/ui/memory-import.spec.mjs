import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  seedClaudeMemory,
  importedMemory,
  consolidatedMemory,
  consolidationCommand,
  lockImportedMemory,
  importedReferenceFile,
} from '../../../../../services/kernel-adapter/test-support/claude-memory-fixture.mjs';
import { expect, test } from './fixtures.mjs';
import { horizontalOverflow, resizeWindow } from './assertions.mjs';

async function openSettings(page, section = '记忆与导入') {
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page
    .getByRole('menu', { name: '用户菜单' })
    .getByRole('menuitem', { name: '设置', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: section, exact: true })
    .click();
  await page
    .locator('summary')
    .filter({ hasText: /^导入历史$/ })
    .click();
}

async function confirmAlpha(page) {
  const dialog = await openImport(page);
  await selectAlpha(dialog);
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('alpha-project：资料已导入')).toBeVisible();
  return dialog;
}

async function sources(electronApp) {
  const workspace = realpathSync(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace),
  );
  const home = dirname(workspace);
  const alpha = seedClaudeMemory(
    home,
    workspace,
    'alpha-project',
    '# Alpha project\nALPHA_IMPORT_EVIDENCE: use violet reports.\n',
  );
  seedClaudeMemory(
    home,
    join(home, 'beta-workspace'),
    'beta-project',
    '# Beta project\nBETA_MUST_NOT_BE_IMPORTED\n',
  );
  return { home, workspace, alpha, kernelHome: join(home, '.evowork', 'kernel') };
}

async function openImport(page) {
  await page.getByLabel('需求输入').fill('/import');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入项目记忆' });
  await expect(dialog.getByRole('button', { name: '检测项目', exact: true })).toBeEnabled();
  return dialog;
}

async function selectAlpha(dialog) {
  await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
  await dialog.getByRole('checkbox', { name: /alpha-project/ }).check();
  await expect(dialog.getByRole('checkbox', { name: /beta-project/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  await expect(dialog).toContainText('通过已配置的模型服务');
}

test('设置及 /import 共用向导，取消零写入、仅选中项目、保留开关、去重与历史恢复', async ({
  page,
  electronApp,
}, testInfo) => {
  const fixture = await sources(electronApp);
  await page.evaluate(() =>
    window.evowork.setMemorySettings({
      enabled: false,
      useMemories: false,
      generateMemories: false,
    }),
  );
  const input = page.getByLabel('需求输入');
  await input.fill('/imp');
  await page.getByRole('option', { name: /import ·/ }).click();
  let dialog = page.getByRole('dialog', { name: '导入项目记忆' });
  await selectAlpha(dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toEqual([]);
  expect(importedMemory(fixture.kernelHome, 'alpha-project')).toBeNull();
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);

  dialog = await openImport(page);
  await selectAlpha(dialog);
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('alpha-project：资料已导入')).toBeVisible();
  await expect(dialog).toContainText('不代表记忆已经整理就绪');
  expect(importedMemory(fixture.kernelHome, 'alpha-project')).toEqual({
    scope: { cwd: fixture.workspace },
    text: '# Alpha project\nALPHA_IMPORT_EVIDENCE: use violet reports.\n',
  });
  expect(importedMemory(fixture.kernelHome, 'beta-project')).toBeNull();
  expect(readFileSync(join(fixture.alpha, 'memory', 'MEMORY.md'), 'utf8')).toContain(
    'ALPHA_IMPORT_EVIDENCE',
  );
  expect(await page.evaluate(() => window.evowork.getMemorySettings())).toMatchObject({
    enabled: false,
    useMemories: false,
    generateMemories: false,
  });
  await page.screenshot({ path: testInfo.outputPath('import-result.png') });
  await dialog.getByRole('button', { name: '开启读取', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '开启读取', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.evowork.getMemorySettings())).toMatchObject({
    enabled: true,
    useMemories: true,
    generateMemories: false,
  });
  await dialog.getByRole('button', { name: '重新检测项目' }).click();
  await expect(dialog.getByRole('checkbox', { name: /alpha-project/ })).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: /beta-project/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await input.fill('/memories');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page
    .getByRole('dialog', { name: '记忆设置' })
    .getByRole('button', { name: '导入已有记忆', exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: '记忆设置' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page
    .getByRole('menu', { name: '用户菜单' })
    .getByRole('menuitem', { name: '设置', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '记忆与导入', exact: true })
    .click();
  await expect(page.getByLabel('记忆导入历史')).toContainText('alpha-project：资料已导入');
  await page.getByRole('button', { name: '导入已有记忆', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
  await dialog.getByRole('checkbox', { name: /beta-project/ }).check();
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('beta-project：资料已导入')).toBeVisible();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByLabel('记忆导入历史')).toContainText('beta-project：资料已导入');
  await page.reload();
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getMemoryImportHistory())).length)
    .toBe(2);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
  await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
    timeout: 60000,
  });
  expect((await page.evaluate(() => window.evowork.getMemoryImportHistory())).length).toBe(2);
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
  const requests = await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.requestBodies);
  expect(requests.some((body) => body.includes('/import'))).toBe(false);
});

test('发货内核实际整理导入资料，新任务收到记忆索引，禁读任务不注入', async ({
  page,
  electronApp,
}, testInfo) => {
  const fixture = await sources(electronApp);
  const access = await page.evaluate(() => window.evowork.listModels());
  const modelId = access.models.find((model) => !model.denied).id;
  const settingsResult = await page.evaluate(
    (modelId) =>
      window.evowork.setMemorySettings({
        enabled: true,
        useMemories: true,
        generateMemories: false,
        consolidationModel: modelId,
      }),
    modelId,
  );
  expect(settingsResult.ok).toBe(true);
  const dialog = await openImport(page);
  await selectAlpha(dialog);
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('alpha-project：资料已导入')).toBeVisible();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await electronApp.evaluate((_, cmd) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen(
      'import-consolidation',
      (view) =>
        view.text.includes('phase2_workspace_diff.md') && !view.calls.includes('exec_command'),
      { tool: 'exec_command', args: { cmd } },
    );
    gateway.scriptWhen(
      'import-consolidation-done',
      (view) => view.text.includes('IMPORTED_EVIDENCE_READ'),
      { kind: 'text', text: 'Imported evidence consolidated.' },
    );
  }, consolidationCommand);
  const project = await page.evaluate(
    (path) => window.evowork.createProject({ name: '导入记忆验收', path }),
    fixture.workspace,
  );
  expect(project.ok).toBe(true);
  const workspaceId = project.projectId ?? project.projects[0].id;
  const send = (text, useMemories) =>
    page.evaluate(
      ({ text, workspaceId, useMemories, modelId }) =>
        window.evowork.send({
          text,
          workspaceId,
          modelId,
          ...(useMemories === undefined ? {} : { useMemories }),
        }),
      { text, workspaceId, useMemories, modelId },
    );
  await send('IMPORT_CONSOLIDATION_TRIGGER_UI');
  await expect
    .poll(() => consolidatedMemory(fixture.kernelHome)?.memory, { timeout: 45000 })
    .toContain('ALPHA_IMPORT_EVIDENCE');
  await expect
    .poll(() =>
      electronApp.evaluate(() =>
        globalThis.__evoworkE2E.gateway.matchedBody('import-consolidation-done'),
      ),
    )
    .toContain('ALPHA_IMPORT_EVIDENCE');
  expect(consolidatedMemory(fixture.kernelHome).memory).not.toContain('BETA_MUST_NOT_BE_IMPORTED');
  await send('IMPORT_FUTURE_TASK_UI');
  await expect
    .poll(() =>
      electronApp.evaluate(() =>
        globalThis.__evoworkE2E.gateway.requestBodies.find((body) =>
          body.includes('IMPORT_FUTURE_TASK_UI'),
        ),
      ),
    )
    .toContain('Imported project reference');
  await send('IMPORT_BLOCKED_TASK_UI', false);
  await expect
    .poll(() =>
      electronApp.evaluate(
        () =>
          globalThis.__evoworkE2E.gateway.requestBodies.filter((body) =>
            body.includes('IMPORT_BLOCKED_TASK_UI'),
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  const blocked = await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.requestBodies.filter((body) =>
      body.includes('IMPORT_BLOCKED_TASK_UI'),
    ),
  );
  expect(blocked.every((body) => !body.includes('Imported project reference'))).toBe(true);
  expect(await page.evaluate(() => window.evowork.getMemorySettings())).toMatchObject({
    generateMemories: false,
  });
  await page.screenshot({ path: testInfo.outputPath('import-native-consolidation.png') });
});

test('原生批次部分失败时保留成功项目并显示失败原因，可重新检测重试', async ({
  page,
  electronApp,
}) => {
  const fixture = await sources(electronApp);
  let dialog = await openImport(page);
  await selectAlpha(dialog);
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('alpha-project：资料已导入')).toBeVisible();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  writeFileSync(join(fixture.alpha, 'memory', 'MEMORY.md'), '# Changed alpha memory\n');
  lockImportedMemory(fixture.kernelHome, 'alpha-project', true);
  try {
    dialog = await openImport(page);
    await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /alpha-project/ }).check();
    await dialog.getByRole('checkbox', { name: /beta-project/ }).check();
    await dialog.getByRole('button', { name: '继续', exact: true }).click();
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(dialog.getByText('beta-project：资料已导入')).toBeVisible();
    await expect(dialog.getByText(/alpha-project：无法读取来源文件/)).toBeVisible();
  } finally {
    lockImportedMemory(fixture.kernelHome, 'alpha-project', false);
  }
  expect(importedMemory(fixture.kernelHome, 'beta-project').text).toContain(
    'BETA_MUST_NOT_BE_IMPORTED',
  );
  await dialog.getByRole('button', { name: '重新检测项目', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /alpha-project/ })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /beta-project/ })).toHaveCount(0);
});

test('空来源及缺少可靠项目目录时无候选，重新检测可发现新增项目', async ({ page, electronApp }) => {
  const dialog = await openImport(page);
  await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
  await expect(dialog.getByText(/未找到有可靠项目目录/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '继续', exact: true })).toBeDisabled();
  const fixture = await sources(electronApp);
  const orphan = join(fixture.home, '.claude', 'projects', 'orphan-without-cwd', 'memory');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'MEMORY.md'), 'ORPHAN_MUST_NOT_IMPORT');
  await dialog.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /alpha-project/ })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /orphan-without-cwd/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '继续', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /alpha-project/ }).check();
  await dialog.getByRole('checkbox', { name: /alpha-project/ }).uncheck();
  await expect(dialog.getByRole('button', { name: '继续', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toEqual([]);
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
});

test('返回修改项目及取消零写入，个性化入口保持原生成和模型设置，新建任务可达', async ({
  page,
  electronApp,
}) => {
  const fixture = await sources(electronApp);
  const model = (await page.evaluate(() => window.evowork.listModels())).models[0].id;
  expect(
    (
      await page.evaluate(
        (model) =>
          window.evowork.setMemorySettings({
            enabled: true,
            useMemories: true,
            generateMemories: false,
            extractModel: model,
            consolidationModel: model,
          }),
        model,
      )
    ).ok,
  ).toBe(true);
  await openSettings(page, '记忆与导入');
  await page.getByRole('button', { name: '导入已有记忆', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '导入项目记忆' });
  await selectAlpha(dialog);
  await dialog.getByRole('button', { name: '返回选择项目' }).click();
  await expect(dialog.getByRole('checkbox', { name: /alpha-project/ })).toBeChecked();
  await dialog.getByRole('checkbox', { name: /alpha-project/ }).uncheck();
  await dialog.getByRole('checkbox', { name: /beta-project/ }).check();
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  await expect(dialog.getByRole('listitem')).toHaveText(['beta-project']);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(importedMemory(fixture.kernelHome, 'alpha-project')).toBeNull();
  expect(importedMemory(fixture.kernelHome, 'beta-project')).toBeNull();
  await page.getByRole('button', { name: '导入已有记忆', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入项目记忆' });
  await selectAlpha(dialog);
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('alpha-project：资料已导入')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '开启读取', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.evowork.getMemorySettings())).toMatchObject({
    enabled: true,
    useMemories: true,
    generateMemories: false,
    extractModel: model,
    consolidationModel: model,
  });
  await dialog.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('需求输入')).toBeVisible();
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
});

test('手动更新同步来源修改和删除，检测前不自动同步，历史与来源保持可追溯', async ({
  page,
  electronApp,
}) => {
  const fixture = await sources(electronApp);
  const detail = join(fixture.alpha, 'memory', 'obsolete.md');
  writeFileSync(detail, 'ORIGINAL_DETAIL');
  let dialog = await confirmAlpha(page);
  expect(importedReferenceFile(fixture.kernelHome, 'alpha-project', 'obsolete.md')).toBe(
    'ORIGINAL_DETAIL',
  );
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  writeFileSync(
    join(fixture.alpha, 'memory', 'MEMORY.md'),
    '# Updated alpha\nUPDATED_ONLY_MARKER\n',
  );
  rmSync(detail);
  expect(importedMemory(fixture.kernelHome, 'alpha-project').text).toContain(
    'ALPHA_IMPORT_EVIDENCE',
  );
  dialog = await openImport(page);
  await selectAlpha(dialog);
  await expect(dialog).toContainText('包括来源文件的删减');
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('alpha-project：资料已导入')).toBeVisible();
  expect(importedMemory(fixture.kernelHome, 'alpha-project').text).toContain('UPDATED_ONLY_MARKER');
  expect(importedReferenceFile(fixture.kernelHome, 'alpha-project', 'obsolete.md')).toBeNull();
  expect(readFileSync(join(fixture.alpha, 'memory', 'MEMORY.md'), 'utf8')).toContain(
    'UPDATED_ONLY_MARKER',
  );
  const records = await page.evaluate(() => window.evowork.getMemoryImportHistory());
  expect(records).toHaveLength(2);
  expect(new Set(records.map((r) => r.id)).size).toBe(2);
  await dialog.getByRole('button', { name: '重新检测项目' }).click();
  await expect(dialog.getByRole('checkbox', { name: /alpha-project/ })).toHaveCount(0);
});

test('确认时来源已删除则拒绝写入，可重新检测导入剩余项目', async ({ page, electronApp }) => {
  const fixture = await sources(electronApp);
  const dialog = await openImport(page);
  await selectAlpha(dialog);
  rmSync(fixture.alpha, { recursive: true });
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('来源项目已变化或已导入');
  expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toEqual([]);
  expect(importedMemory(fixture.kernelHome, 'alpha-project')).toBeNull();
  await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /alpha-project/ })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: /beta-project/ }).check();
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('beta-project：资料已导入')).toBeVisible();
});

test('确认前内核重启使旧选择失效，拒绝零写入，重新检测可恢复', async ({ page, electronApp }) => {
  const fixture = await sources(electronApp);
  const dialog = await openImport(page);
  await selectAlpha(dialog);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
  await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
    timeout: 60000,
  });
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('重新检测');
  expect(importedMemory(fixture.kernelHome, 'alpha-project')).toBeNull();
  expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toEqual([]);
  await selectAlpha(dialog);
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText('alpha-project：资料已导入')).toBeVisible();
});

test('长项目列表在宽中窄窗口可滚动到最后项目，确认按钮和键盘焦点始终可达', async ({
  page,
  electronApp,
}, info) => {
  const fixture = await sources(electronApp);
  for (let i = 0; i < 36; i++)
    seedClaudeMemory(
      fixture.home,
      join(fixture.home, `layout-${i}`),
      `layout-${String(i).padStart(2, '0')}-${'中文长项目名称'.repeat(8)}`,
      `Synthetic project ${i}`,
    );
  const dialog = await openImport(page);
  await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
  const last = dialog.getByRole('checkbox').last();
  for (const [width, height] of [
    [1200, 760],
    [900, 600],
    [480, 560],
  ]) {
    await resizeWindow(electronApp, width, height);
    await last.check();
    await expect(last).toBeInViewport();
    await expect(dialog.getByRole('button', { name: '继续', exact: true })).toBeInViewport();
    await expect.poll(() => horizontalOverflow(page)).toBeLessThanOrEqual(1);
    const geometry = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
        overflow: el.scrollWidth - el.clientWidth,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`import-projects-${width}.png`) });
    await last.uncheck();
  }
  await last.check();
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toEqual([]);
});

test('模型网关不可用时 /import 仍在本地工作，复制成功且不创建模型任务', async ({
  page,
  electronApp,
}) => {
  const fixture = await sources(electronApp);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.close());
  await page.reload();
  await expect(page.getByText(/连不上模型网关/)).toBeVisible();
  const dialog = await confirmAlpha(page);
  await expect(dialog).toContainText('不代表记忆已经整理就绪');
  expect(importedMemory(fixture.kernelHome, 'alpha-project').text).toContain(
    'ALPHA_IMPORT_EVIDENCE',
  );
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
  const requests = await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.requestBodies);
  expect(requests).toHaveLength(0);
});

test.describe('原生写入后丢失响应', () => {
  test.use({ desktopEnv: { EVOWORK_UI_MEMORY_RPC_FAULT: '1' } });
  test('未知结果不重放，原生历史可核对真实成功，重新检测去重', async ({
    page,
    electronApp,
  }, info) => {
    const fixture = await sources(electronApp);
    const dialog = await openImport(page);
    await selectAlpha(dialog);
    await electronApp.evaluate(() => globalThis.__evoworkE2E.memoryImportFaults.arm());
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '正在处理…', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('导入结果尚未确认', { timeout: 30000 });
    expect(importedMemory(fixture.kernelHome, 'alpha-project').text).toContain(
      'ALPHA_IMPORT_EVIDENCE',
    );
    expect(
      await electronApp.evaluate(() => globalThis.__evoworkE2E.memoryImportFaults.snapshot()),
    ).toEqual({ writes: 1, dropped: 1 });
    await page.screenshot({ path: info.outputPath('import-unknown-result.png') });
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await openSettings(page);
    await page.getByRole('button', { name: '刷新导入历史', exact: true }).click();
    await expect(page.getByLabel('记忆导入历史')).toContainText('alpha-project：资料已导入');
    await page.getByRole('button', { name: '导入已有记忆', exact: true }).click();
    await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /alpha-project/ })).toHaveCount(0);
    expect((await page.evaluate(() => window.evowork.getMemoryImportHistory())).length).toBe(1);
    expect(
      await electronApp.evaluate(() => globalThis.__evoworkE2E.memoryImportFaults.snapshot()),
    ).toEqual({ writes: 1, dropped: 1 });
  });
});

test.describe('显式关闭记忆导入', () => {
  test.use({ desktopEnv: { EVOWORK_UI_MEMORY_IMPORT: 'disabled' } });
  test('升级保留关闭设置，入口明确说明且不允许检测', async ({ page, electronApp }) => {
    await sources(electronApp);
    await page.getByLabel('需求输入').fill('/import');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入项目记忆' });
    await expect(dialog.getByText('当前配置未开启外部记忆导入。')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '检测项目', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toEqual([]);
    expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
  });
});

test('自动同步默认关闭、限定已授权项目，定时同步更新和删减，关闭后停止', async ({
  page,
  electronApp,
}, info) => {
  const fixture = await sources(electronApp);
  writeFileSync(join(fixture.alpha, 'memory', 'obsolete.md'), 'REMOVE_FROM_IMPORTED_COPY');
  const dialog = await confirmAlpha(page);
  await expect(dialog.getByLabel('记忆整理状态')).toContainText('不提供整理进度');
  await dialog.getByRole('button', { name: '刷新整理状态' }).click();
  await expect(dialog.getByLabel('记忆整理状态')).toContainText('整体记忆状态');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await openSettings(page);
  const sync = page.getByLabel('记忆自动同步');
  const toggle = sync.getByRole('checkbox', { name: '自动更新已导入的项目记忆' });
  await expect(toggle).not.toBeChecked();
  writeFileSync(join(fixture.alpha, 'memory', 'MEMORY.md'), '# Alpha auto v2\nAUTO_SYNC_V2\n');
  expect(importedMemory(fixture.kernelHome, 'alpha-project').text).not.toContain('AUTO_SYNC_V2');
  await toggle.check();
  await expect
    .poll(() => importedMemory(fixture.kernelHome, 'alpha-project')?.text)
    .toContain('AUTO_SYNC_V2');
  await expect
    .poll(
      async () => (await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync?.pending,
    )
    .toBeUndefined();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync?.lastCompletedAt,
    )
    .toBeTruthy();
  expect(importedMemory(fixture.kernelHome, 'beta-project')).toBeNull();
  expect(
    (await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync.projectKeys,
  ).toEqual(['alpha-project']);
  writeFileSync(join(fixture.alpha, 'memory', 'MEMORY.md'), '# Alpha auto v3\nAUTO_SYNC_V3\n');
  rmSync(join(fixture.alpha, 'memory', 'obsolete.md'));
  await expect
    .poll(() => importedMemory(fixture.kernelHome, 'alpha-project')?.text, { timeout: 75000 })
    .toContain('AUTO_SYNC_V3');
  await expect(sync).toContainText('最近同步完成');
  expect(importedReferenceFile(fixture.kernelHome, 'alpha-project', 'obsolete.md')).toBeNull();
  expect(importedMemory(fixture.kernelHome, 'beta-project')).toBeNull();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  writeFileSync(
    join(fixture.alpha, 'memory', 'MEMORY.md'),
    '# Alpha paused\nMUST_NOT_SYNC_WHILE_OFF\n',
  );
  const count = (await page.evaluate(() => window.evowork.getMemoryImportHistory())).length;
  await page.waitForTimeout(61000);
  expect((await page.evaluate(() => window.evowork.getMemoryImportHistory())).length).toBe(count);
  expect(importedMemory(fixture.kernelHome, 'alpha-project').text).toContain('AUTO_SYNC_V3');
  await page.reload();
  expect((await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync.enabled).toBe(
    false,
  );
  await openSettings(page);
  await resizeWindow(electronApp, 480, 720);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('memory-auto-sync.png') });
});

test('原生结构化记忆引用在实时消息和刷新历史中显示', async ({ page, electronApp }, info) => {
  await electronApp.evaluate(() => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen('citation', (v) => v.text.includes('MEMORY_CITATION_UI'), {
      kind: 'text',
      text: '使用项目惯例。<oai-mem-citation><citation_entries>\nMEMORY.md:1-2|note=[Imported project convention]\n</citation_entries>\n<rollout_ids>\n</rollout_ids></oai-mem-citation>',
    });
  });
  await page.getByLabel('需求输入').fill('MEMORY_CITATION_UI');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const citation = page.getByRole('button', { name: '记忆引用', exact: true });
  await expect(citation).toBeVisible();
  await citation.click();
  await expect(page.getByText('MEMORY.md:1–2', { exact: true })).toBeVisible();
  await expect(page.getByText('Imported project convention', { exact: true })).toBeVisible();
  await expect(page.getByText(/不代表完整的检索记录/)).toBeVisible();
  await page.reload();
  await page
    .getByRole('navigation', { name: '侧边栏' })
    .getByRole('button', { name: 'MEMORY_CITATION_UI', exact: true })
    .click();
  await expect(citation).toBeVisible();
  await citation.click();
  await expect(page.getByText('MEMORY.md:1–2', { exact: true })).toBeVisible();
  await expect(page.locator('.ew-markdown')).not.toContainText('oai-mem-citation');
  await page.screenshot({ path: info.outputPath('memory-citation-history.png') });
});

test('V2 整理状态读取真实整体就绪接口，不把零任务显示为正在整理', async ({ page, electronApp }) => {
  const fixture = await sources(electronApp);
  const configPath = join(fixture.kernelHome, 'config.toml');
  let config = readFileSync(configPath, 'utf8');
  config = config.includes('[memories]')
    ? config.replace('[memories]', '[memories]\nversion = "v2"')
    : config + '\n[memories]\nversion = "v2"\n';
  writeFileSync(configPath, config);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
  await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
    timeout: 60000,
  });
  const dialog = await confirmAlpha(page);
  await expect(dialog.getByLabel('记忆整理状态')).toContainText(
    '尚未达到记忆就绪条件，已整理 0 个任务',
  );
  const settings = await page.evaluate(() => window.evowork.getMemorySettings());
  expect(settings).toMatchObject({
    version: 'v2',
    statusSupported: true,
    ready: false,
    consolidatedThreads: 0,
  });
  await dialog.getByRole('button', { name: '刷新整理状态' }).click();
  await expect(dialog.getByLabel('记忆整理状态')).toContainText('不能确认某次导入的整理进度');
});

test('自动同步遇到原生复制失败会暂停，历史保留失败结果', async ({ page, electronApp }) => {
  const fixture = await sources(electronApp);
  const dialog = await confirmAlpha(page);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  writeFileSync(join(fixture.alpha, 'memory/MEMORY.md'), '# Cannot sync this version\n');
  lockImportedMemory(fixture.kernelHome, 'alpha-project', true);
  try {
    await openSettings(page);
    const sync = page.getByLabel('记忆自动同步');
    await sync.getByRole('checkbox').check();
    await expect(sync.getByRole('alert')).toContainText('部分项目同步失败');
    await expect(sync.getByRole('checkbox')).not.toBeChecked();
    expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toHaveLength(2);
    expect(importedMemory(fixture.kernelHome, 'alpha-project').text).toContain(
      'ALPHA_IMPORT_EVIDENCE',
    );
  } finally {
    lockImportedMemory(fixture.kernelHome, 'alpha-project', false);
  }
});

test.describe('自动同步原生响应丢失', () => {
  test.use({ desktopEnv: { EVOWORK_UI_MEMORY_RPC_FAULT: '1' } });
  test('已写入但结果未知时暂停，核对历史后才显式恢复，无自动重放', async ({
    page,
    electronApp,
  }, info) => {
    const fixture = await sources(electronApp);
    const dialog = await confirmAlpha(page);
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    writeFileSync(
      join(fixture.alpha, 'memory/MEMORY.md'),
      '# Unknown sync\nUNKNOWN_SYNC_COMPLETED\n',
    );
    await electronApp.evaluate(() => globalThis.__evoworkE2E.memoryImportFaults.arm());
    await openSettings(page);
    const sync = page.getByLabel('记忆自动同步');
    await sync.getByRole('checkbox').check();
    await expect(sync.getByRole('alert')).toContainText('已暂停', { timeout: 30000 });
    await expect(sync.getByRole('checkbox')).not.toBeChecked();
    expect(importedMemory(fixture.kernelHome, 'alpha-project').text).toContain(
      'UNKNOWN_SYNC_COMPLETED',
    );
    await page.getByRole('button', { name: '刷新导入历史', exact: true }).click();
    expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toHaveLength(2);
    await page.waitForTimeout(61000);
    expect(
      await electronApp.evaluate(() => globalThis.__evoworkE2E.memoryImportFaults.snapshot()),
    ).toEqual({ writes: 2, dropped: 1 });
    await sync.getByRole('checkbox').check();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync?.lastCheckedAt,
      )
      .toBeTruthy();
    expect(
      await electronApp.evaluate(() => globalThis.__evoworkE2E.memoryImportFaults.snapshot()),
    ).toEqual({ writes: 2, dropped: 1 });
    await sync.getByRole('checkbox').uncheck();
    await page.screenshot({ path: info.outputPath('memory-sync-unknown.png') });
  });
});
