import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { realpathSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from './fixtures.mjs';
import { kernelProvenanceProblem } from '../../../../../scripts/kernel-provenance.mjs';
import {
  importedMemory,
  seedClaudeMemory,
} from '../../../../../services/kernel-adapter/test-support/claude-memory-fixture.mjs';
import { removeE2EHome } from '../harness/runner.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../../../..');

test('整个应用关闭重开，项目记忆、读取设置、原生历史和去重均保持', async ({
  playwright: _playwright,
}, info) => {
  const binary =
    process.env.EVOWORK_APP_SERVER ??
    join(
      root,
      'build/kernel',
      `${platform() === 'darwin' ? 'mac' : platform() === 'win32' ? 'win' : 'linux'}-${arch()}`,
      platform() === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
    );
  expect(kernelProvenanceProblem(binary, root)).toBeFalsy();
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
  let app,
    home,
    success = false;
  const lifecycles = [];
  async function recordLifecycle() {
    const events = await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
    expect(events.filter((event) => event.kind === 'exited')).toEqual([]);
    lifecycles.push(events);
    writeFileSync(info.outputPath('kernel-lifecycle.json'), JSON.stringify(lifecycles, null, 2));
  }
  async function launch(reuse) {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [join(root, 'apps/desktop/test/e2e/harness/ui-entry.mjs')],
      cwd: root,
      env: {
        ...env,
        EVOWORK_E2E_REPO_ROOT: root,
        EVOWORK_APP_SERVER: binary,
        ...(reuse ? { EVOWORK_UI_REUSE_HOME: reuse } : {}),
      },
      timeout: 120000,
    });
    const page = await app.firstWindow();
    await expect
      .poll(() => app.evaluate(() => globalThis.__evoworkE2E?.ready === true), { timeout: 120000 })
      .toBe(true);
    await expect(page.getByLabel('需求输入')).toBeVisible();
    return page;
  }
  try {
    let page = await launch();
    const workspace = realpathSync(await app.evaluate(() => globalThis.__evoworkE2E.workspace));
    home = dirname(workspace);
    seedClaudeMemory(
      home,
      workspace,
      'restart-project',
      '# Restart project\nPERSISTENT_IMPORT_MARKER\n',
    );
    expect(
      (
        await page.evaluate(() =>
          window.evowork.setMemorySettings({
            enabled: false,
            useMemories: false,
            generateMemories: false,
          }),
        )
      ).ok,
    ).toBe(true);
    await page.getByLabel('需求输入').fill('/import');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '导入项目记忆' });
    await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /restart-project/ }).check();
    await dialog.getByRole('button', { name: '继续', exact: true }).click();
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(dialog.getByText('restart-project：资料已导入')).toBeVisible();
    const before = await page.evaluate(() => window.evowork.getMemoryImportHistory());
    expect(before).toHaveLength(1);
    await recordLifecycle();
    await app.close();
    app = undefined;
    page = await launch(home);
    expect(await page.evaluate(() => window.evowork.getMemoryImportHistory())).toEqual(before);
    expect(await page.evaluate(() => window.evowork.getMemorySettings())).toMatchObject({
      enabled: false,
      useMemories: false,
      generateMemories: false,
    });
    expect(importedMemory(join(home, '.evowork', 'kernel'), 'restart-project')).toMatchObject({
      scope: { cwd: workspace },
      text: expect.stringContaining('PERSISTENT_IMPORT_MARKER'),
    });
    await page.getByRole('button', { name: /菜单$/ }).click();
    await page
      .getByRole('menu', { name: '用户菜单' })
      .getByRole('menuitem', { name: '设置', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '导入', exact: true })
      .click();
    await expect(page.getByLabel('记忆导入历史')).toContainText('restart-project：资料已导入');
    await page.getByRole('button', { name: '导入已有记忆', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '导入项目记忆' });
    await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
    await expect(dialog.getByText(/未找到有可靠项目目录/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: '继续', exact: true })).toBeDisabled();
    expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('import-whole-app-restarted.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('checkbox', { name: '自动更新已导入的项目记忆' }).check();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync?.enabled,
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync?.lastCheckedAt,
      )
      .toBeTruthy();
    await recordLifecycle();
    await app.close();
    app = undefined;
    writeFileSync(
      join(home, '.claude/projects/restart-project/memory/MEMORY.md'),
      '# Restart project\nSYNC_AFTER_APP_RESTART\n',
    );
    page = await launch(home);
    await expect
      .poll(() => importedMemory(join(home, '.evowork/kernel'), 'restart-project')?.text)
      .toContain('SYNC_AFTER_APP_RESTART');
    await expect
      .poll(async () => (await page.evaluate(() => window.evowork.getMemoryImportHistory())).length)
      .toBe(2);
    expect((await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync).toMatchObject({
      enabled: true,
      projectKeys: ['restart-project'],
    });
    expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
    await recordLifecycle();
    success = true;
  } finally {
    if (app) await app.close();
    if (success && home) removeE2EHome(home);
  }
});
