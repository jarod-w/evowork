import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from './fixtures.mjs';
import { kernelProvenanceProblem } from '../../../../../scripts/kernel-provenance.mjs';
import { removeE2EHome } from '../harness/runner.mjs';
import { appTestEnvironment } from '../harness/app-test-path.mjs';
import {
  evidence,
  isolatedExecution,
  monitor,
  readRun,
  runStatus,
  saveAgent,
  scriptNodes,
  startRun,
  taggedTeam,
} from './agent-workspace-journey.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../../../..');

test('智能体整应用关闭重开：配置与真实输出保留，等待中的运行中断且不自动重投', async ({
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
  let app,
    home,
    success = false;
  const lifecycles = [];
  async function captureLifecycle() {
    const events = await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
    expect(events.filter((event) => event.kind === 'exited')).toEqual([]);
    lifecycles.push(events);
    writeFileSync(info.outputPath('restart-lifecycle.json'), JSON.stringify(lifecycles, null, 2));
  }
  async function launch(reuse) {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [join(root, 'apps/desktop/test/e2e/harness/ui-entry.mjs')],
      cwd: root,
      env: {
        ...appTestEnvironment(process.env),
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
    home = dirname(await app.evaluate(() => globalThis.__evoworkE2E.workspace));
    await isolatedExecution(page);
    const agent = await saveAgent(
      page,
      taggedTeam({ condition: 'review', name: '重启持久化团队' }),
    );
    await scriptNodes(app, agent);
    await monitor(page, agent);
    await startRun(page, '先完成入口，等待用户复核');
    const before = await runStatus(page, agent, 'waiting');
    expect(before.nodes[0].output).toContain('已处理-0');
    await captureLifecycle();
    await app.close();
    app = undefined;
    page = await launch(home);
    expect(await page.evaluate(() => window.evowork.listAgentWorkspace())).toEqual([agent]);
    await monitor(page, agent);
    const after = await runStatus(page, agent, 'interrupted');
    expect(after.id).toBe(before.id);
    expect(after.nodes[0].output).toBe(before.nodes[0].output);
    expect(after.nodes.slice(1).every((n) => !n.threadId)).toBe(true);
    await expect(page.getByRole('log')).toContainText('运行已中断');
    await expect(page.getByRole('button', { name: '确认并继续', exact: true })).toHaveCount(0);
    await page.waitForTimeout(1200);
    expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(1);
    expect((await readRun(page, agent)).status).toBe('interrupted');
    await expect(
      page.evaluate(
        (run) =>
          window.evowork.decideAgentWorkspaceRun({
            runId: run.id,
            nodeId: run.nodes[0].nodeId,
            action: 'confirm',
          }),
        after,
      ),
    ).rejects.toThrow('运行已结束');
    await captureLifecycle();
    await evidence(info, { before, after });
    await page.screenshot({ path: info.outputPath('workspace-whole-app-restart.png') });
    success = true;
  } finally {
    if (app) await app.close();
    if (success && home) removeE2EHome(home);
  }
});
