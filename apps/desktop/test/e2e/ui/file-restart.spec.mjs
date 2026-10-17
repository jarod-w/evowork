import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import {
  changes,
  results,
  revertSelected,
  scriptFileTools,
  selectTask,
  settle,
  taskId,
} from './file-results-support.mjs';
import { kernelProvenanceProblem } from '../../../../../scripts/kernel-provenance.mjs';
import { removeE2EHome } from '../harness/runner.mjs';
const require = createRequire(import.meta.url),
  root = resolve(import.meta.dirname, '../../../../..');

test('关闭整个应用再启动，原文件记录和撤销副本仍有效', async ({
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
  const { ELECTRON_RUN_AS_NODE: _node, ...parentEnv } = process.env;
  let app,
    home,
    ok = false;
  async function launch(reuse) {
    const app = await electron.launch({
      executablePath: require('electron'),
      args: [join(root, 'apps/desktop/test/e2e/harness/ui-entry.mjs')],
      cwd: root,
      env: {
        ...parentEnv,
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
    return { app, page };
  }
  try {
    let launched = await launch();
    app = launched.app;
    let page = launched.page;
    home = await app.evaluate(() => globalThis.__evoworkE2E.home);
    const workspace = await app.evaluate(() => globalThis.__evoworkE2E.workspace);
    const path = join(workspace, 'persistent.txt');
    writeFileSync(path, 'original bytes');
    await scriptFileTools(
      app,
      'FILE-RESTART',
      [{ tool: 'exec_command', args: { cmd: 'printf changed > persistent.txt' } }],
      'RESTART DONE',
    );
    await startTaskInWorkspace(page, app, 'FILE-RESTART');
    const id = await taskId(page, 'FILE-RESTART');
    await settle(page, 'RESTART DONE');
    expect((await results(page, id)).workspace.thread[0].reversible).toBe(true);
    await app.close();
    app = undefined;
    launched = await launch(home);
    app = launched.app;
    page = launched.page;
    await selectTask(page, 'FILE-RESTART');
    await changes(page);
    await expect(page.locator('.ew-diff-body')).toContainText('-original bytes');
    await expect(page.locator('.ew-diff-body')).toContainText('+changed');
    await expect(page.getByRole('button', { name: '撤销这次变更', exact: true })).toBeVisible();
    await revertSelected(page);
    await expect.poll(() => readFileSync(path, 'utf8')).toBe('original bytes');
    expect((await results(page, id)).workspace.thread).toEqual([]);
    await page.screenshot({ path: info.outputPath('reopened-app-restored.png') });
    ok = true;
  } finally {
    if (app) await app.close();
    if (ok && home) removeE2EHome(home);
  }
});
