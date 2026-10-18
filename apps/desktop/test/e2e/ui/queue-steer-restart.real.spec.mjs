import { _electron as electron } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { kernelProvenanceProblem } from '../../../../../scripts/kernel-provenance.mjs';
import { selectRealModel } from '../harness/real-models.mjs';
import { removeE2EHome } from '../harness/runner.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../../../..');
const input = (page) => page.getByLabel('需求输入');
const queue = (page) => page.getByLabel('排队中的追问');
const composer = (page) => page.getByLabel('输入区');
const deliveryMethods = [
  'thread/start',
  'turn/start',
  'turn/steer',
  'thread/queue/add',
  'thread/queue/start',
];
const users = (history, marker) =>
  history.items.filter(
    (item) => item.type === 'userMessage' && JSON.stringify(item).includes(marker),
  );

async function journey(info, run) {
  const selected = selectRealModel();
  expect(selected.upstreamModel).toBe('mimo-v2.6-flash');
  expect(selected.baseUrl).toBe('https://api.xiaomimimo.com/v1');
  const key = process.env.EVOWORK_UI_MODEL_KEY;
  if (!key) throw new Error('真实模型重启验收需要 EVOWORK_UI_MODEL_KEY，不允许跳过');
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
    page,
    home,
    workspace,
    taskId,
    ok = false;
  const boots = [];
  const mainOutput = [];
  const observations = [];
  const suffix = randomBytes(6).toString('hex');
  const original = `REALFOLLOW_RESTART_${suffix}`;
  const queued = `REALFOLLOW_ONCE_${suffix}`;
  const wire = () => {
    const path = home && join(home, 'follow-up-wire.jsonl');
    return path && existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  };
  const history = () => page.evaluate((threadId) => window.evowork.openTask({ threadId }), taskId);
  const save = (name, data) => {
    const body = JSON.stringify(data, null, 2);
    if (body.includes(key)) throw new Error('凭据扫描命中，拒绝保存证据');
    writeFileSync(info.outputPath(name), body);
  };
  async function launch() {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [join(root, 'apps/desktop/test/e2e/harness/ui-entry.mjs')],
      cwd: root,
      env: {
        ...parentEnv,
        EVOWORK_E2E_REPO_ROOT: root,
        EVOWORK_APP_SERVER: binary,
        EVOWORK_UI_REAL_MODEL: '1',
        EVOWORK_UI_REGISTER_MODELS: '1',
        EVOWORK_UI_HOST_GATEWAY: '1',
        EVOWORK_UI_FOLLOW_UP_WIRE: '1',
        EVOWORK_UI_DELIVERY_RPC_FAULT: '1',
        ...(home ? { EVOWORK_UI_REUSE_HOME: home } : {}),
      },
      timeout: 120000,
    });
    const boot = { electronPid: app.process().pid, lifecycle: [], exit: undefined };
    boots.push(boot);
    app.process().stdout?.on('data', (chunk) => mainOutput.push(chunk.toString()));
    app.process().stderr?.on('data', (chunk) => mainOutput.push(chunk.toString()));
    app.process().once('exit', (code, signal) => {
      boot.exit = { code, signal, at: Date.now() };
    });
    page = await app.firstWindow();
    await expect
      .poll(() => app.evaluate(() => globalThis.__evoworkE2E?.ready === true), { timeout: 120000 })
      .toBe(true);
    await expect(input(page)).toBeVisible();
    await expect(page.getByLabel('选择模型')).toContainText(selected.upstreamModel);
    home ??= await app.evaluate(() => globalThis.__evoworkE2E.home);
    workspace ??= realpathSync(await app.evaluate(() => globalThis.__evoworkE2E.workspace));
    boot.lifecycle = await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
  }
  const c = {
    get app() {
      return app;
    },
    get page() {
      return page;
    },
    original,
    queued,
    history,
    wire,
    async begin(loseIpc = false) {
      writeFileSync(
        join(workspace, 'restart_gate.py'),
        [
          'from pathlib import Path',
          'import time',
          "Path('phase-ready').write_text('ready')",
          'deadline = time.monotonic() + 120',
          "while not Path('phase-release').exists():",
          "    if time.monotonic() > deadline: raise RuntimeError('input readiness timed out')",
          '    time.sleep(0.1)',
          "print('本机准备完成')",
          '',
        ].join('\n'),
      );
      if (loseIpc) await c.loseIpc();
      await startTaskInWorkspace(
        page,
        app,
        `${original} 两阶段任务：第一步只运行 python3 restart_gate.py，等返回再计算19*23，将结果437写入original.txt并简短回复。禁止修改脚本或创建phase-release，不并行执行，不联网，不创建子任务或其他会话。`,
      );
      const tasks = (await page.evaluate(() => window.evowork.getStartup())).tasks;
      taskId = tasks.find((task) => task.cwd && realpathSync(task.cwd) === workspace)?.id;
      expect(taskId).toBeTruthy();
      await expect
        .poll(() => existsSync(join(workspace, 'phase-ready')), { timeout: 120000 })
        .toBe(true);
      // The first lost IPC response deliberately prevents navigation to the new task.
      // Public kernel history, rather than this still-pending composer, proves execution.
      if (!loseIpc) await expect(composer(page)).toHaveAttribute('data-run-state', 'running');
      expect((await history()).turns).toHaveLength(1);
      expect((await history()).turns[0].status).toBe('inProgress');
      if (loseIpc) await c.accepted();
    },
    async loseIpc() {
      await app.evaluate(() => {
        const actions = globalThis.__evoworkE2E.host.actions;
        const send = actions.send.bind(actions);
        actions.send = async (payload) => {
          const result = await send(payload);
          globalThis.__evoworkE2E.acceptedBeforeLostIpc = result;
          return new Promise(() => {});
        };
      });
    },
    async accepted() {
      await expect
        .poll(() => app.evaluate(() => Boolean(globalThis.__evoworkE2E.acceptedBeforeLostIpc)))
        .toBe(true);
      observations.push({
        kind: 'accepted-before-lost-ipc',
        at: Date.now(),
        result: await app.evaluate(() => globalThis.__evoworkE2E.acceptedBeforeLostIpc),
      });
    },
    async sendQueued() {
      await input(page).fill(
        `${queued} 计算17+25，将“${queued}:42”作为一整行追加到queued.txt，只追加一次；最终简短回复“${queued} 完成42”。不修改其他文件，不创建子任务或其他会话。`,
      );
      const text = await input(page).inputValue();
      await page.getByRole('button', { name: '排队发送', exact: true }).click();
      return text;
    },
    async stop() {
      await page.getByRole('button', { name: '停止', exact: true }).click();
      await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
      expect((await history()).turns[0].status).toBe('interrupted');
    },
    async reboot(crash) {
      // Finish observing HTTP headers (including task naming) before intentional shutdown.
      // The genuine task command remains blocked on local input readiness.
      await expect
        .poll(
          () =>
            wire().filter((row) => row.type === 'request').length -
            wire().filter((row) => row.type === 'response' || row.type === 'transport-error')
              .length,
          { timeout: 60000 },
        )
        .toBe(0);
      boots[0].exitKind = crash ? 'SIGKILL' : 'closed';
      boots[0].lifecycle = await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
      await c.snapshot('before-restart');
      if (crash) {
        const child = app.process();
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      } else await app.close();
      app = undefined;
      await launch();
      expect(boots[1].electronPid).not.toBe(boots[0].electronPid);
      expect(boots[1].lifecycle[0].pid).not.toBe(boots[0].lifecycle[0].pid);
    },
    async openOriginal() {
      const task = (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
        (task) => task.id === taskId,
      );
      expect(task).toBeTruthy();
      await page
        .getByRole('navigation', { name: '侧边栏' })
        .getByRole('button', { name: task.title, exact: true })
        .click();
      await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
    },
    async noAutomatic() {
      const requests = wire().filter((row) => row.type === 'request').length;
      const checkedAt = Date.now();
      writeFileSync(join(workspace, 'phase-release'), 'ready');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(wire().filter((row) => row.type === 'request')).toHaveLength(requests);
      expect(wire().some((row) => row.markers?.includes(queued))).toBe(false);
      expect(existsSync(join(workspace, 'queued.txt'))).toBe(false);
      const faults = await app.evaluate(() => globalThis.__evoworkE2E.deliveryFaults.snapshot());
      for (const method of deliveryMethods) expect(faults.counts[method] ?? 0, method).toBe(0);
      const h = await history();
      expect(h.turns).toHaveLength(1);
      expect(h.turns[0].status).toBe('interrupted');
      observations.push({
        kind: 'no-automatic',
        checkedAt,
        observedUntil: Date.now(),
        requests,
        faults,
        history: h,
      });
    },
    async resumeOnce() {
      const continuedAt = Date.now();
      await page.getByRole('button', { name: '继续队列', exact: true }).click();
      await expect
        .poll(
          async () => {
            const h = await history();
            return h.turns.length === 2 && h.turns[1].status === 'completed';
          },
          { timeout: 240000, intervals: [500, 1000, 2000] },
        )
        .toBe(true);
      const h = await history();
      expect(users(h, queued)).toHaveLength(1);
      expect(users(h, original)).toHaveLength(1);
      expect(readFileSync(join(workspace, 'queued.txt'), 'utf8').trim().split('\n')).toEqual([
        `${queued}:42`,
      ]);
      expect(
        h.items.some(
          (item) => item.type === 'agentMessage' && item.text?.includes(`${queued} 完成42`),
        ),
      ).toBe(true);
      await expect(queue(page)).toHaveCount(0);
      await expect(page.getByLabel('发送状态')).toHaveCount(0);
      const request = wire().find((row) => row.type === 'request' && row.markers.includes(queued));
      expect(request.at).toBeGreaterThanOrEqual(continuedAt);
      observations.push({
        kind: 'explicit-continue-once',
        continuedAt,
        firstQueuedRequestAt: request.at,
      });
      await c.snapshot('continued-once');
    },
    async snapshot(label) {
      const lifecycle = await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
      expect(lifecycle.filter((row) => row.kind === 'exited')).toHaveLength(0);
      save(`${label}.json`, {
        model: selected.upstreamModel,
        baseUrl: selected.baseUrl,
        boots,
        original,
        queued,
        observations,
        history: taskId ? await history() : undefined,
        wire: wire(),
        lifecycle,
        faults: await app.evaluate(() => globalThis.__evoworkE2E.deliveryFaults.snapshot()),
        pendingSend: await page.evaluate(() => window.evowork.getPendingSend()),
        files: Object.fromEntries(
          ['original.txt', 'queued.txt'].map((name) => [
            name,
            existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), 'utf8') : null,
          ]),
        ),
      });
      await page.screenshot({ path: info.outputPath(`${label}.png`) });
    },
  };
  try {
    await launch();
    await run(c);
    const requests = wire().filter((row) => row.type === 'request');
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        (row) =>
          row.model === selected.upstreamModel &&
          row.endpoint === `${selected.baseUrl}/chat/completions`,
      ),
    ).toBe(true);
    const responses = wire().filter((row) => row.type === 'response');
    const terminal = wire().filter(
      (row) => row.type === 'response' || row.type === 'transport-error',
    );
    expect(terminal).toHaveLength(requests.length);
    for (const request of requests)
      expect(
        terminal.filter((row) => row.pid === request.pid && row.id === request.id),
      ).toHaveLength(1);
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.every((row) => row.status === 200)).toBe(true);
    await c.snapshot('final-evidence');
    ok = true;
  } finally {
    if (app) {
      if (!ok) await c.snapshot('failure').catch(() => undefined);
      await app.close();
    }
    save('process-lifecycle.json', { boots });
    if (ok) {
      expect(boots[0].exit).toMatchObject(
        boots[0].exitKind === 'SIGKILL' ? { signal: 'SIGKILL' } : { code: 0, signal: null },
      );
      expect(boots[1].exit).toMatchObject({ code: 0, signal: null });
    }
    writeFileSync(
      info.outputPath('electron-main.log'),
      mainOutput.join('').split(key).join('[REDACTED]'),
    );
    if (ok && home) removeE2EHome(home);
  }
}

test('MiMo 重启：首轮已接受但 IPC 回执丢失，强退后原身份重试不重投', async ({
  playwright: _,
}, info) => {
  test.setTimeout(360000);
  await journey(info, async (c) => {
    await c.begin(true);
    const originalText = await input(c.page).inputValue();
    await c.reboot(true);
    await expect(input(c.page)).toHaveValue(originalText);
    await input(c.page).press('Enter');
    await expect(input(c.page)).toHaveValue('');
    expect(await c.page.evaluate(() => window.evowork.getPendingSend())).toBeUndefined();
    expect((await c.page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(1);
    expect(users(await c.history(), c.original)).toHaveLength(1);
    await c.noAutomatic();
    await c.snapshot('accepted-first-reconciled');
  });
});

test('MiMo 重启：追问已接受但 IPC 回执丢失，停止强退后不重投或自动续跑', async ({
  playwright: _,
}, info) => {
  test.setTimeout(360000);
  await journey(info, async (c) => {
    await c.begin();
    await c.loseIpc();
    const text = await c.sendQueued();
    await c.accepted();
    await c.stop();
    await c.reboot(true);
    await expect(input(c.page)).toHaveValue(text);
    await input(c.page).press('Enter');
    await expect(input(c.page)).toHaveValue('');
    expect(await c.page.evaluate(() => window.evowork.getPendingSend())).toBeUndefined();
    await expect(queue(c.page)).toContainText(c.queued);
    await c.noAutomatic();
    await c.snapshot('accepted-followup-paused');
    await c.resumeOnce();
  });
});

for (const crash of [false, true])
  test(`MiMo 重启：本机降级队列停止后${crash ? '强制' : '正常'}退出，明确继续才执行一次`, async ({
    playwright: _,
  }, info) => {
    test.setTimeout(360000);
    await journey(info, async (c) => {
      await c.begin();
      await c.app.evaluate(() =>
        globalThis.__evoworkE2E.deliveryFaults.arm('thread/queue/add', 'unavailable', true),
      );
      await c.sendQueued();
      await expect(c.page.getByLabel('发送状态')).toContainText('等待当前任务完成');
      await expect(queue(c.page)).toContainText(c.queued);
      await c.stop();
      await c.reboot(crash);
      await c.openOriginal();
      await expect(queue(c.page)).toContainText(c.queued);
      await c.noAutomatic();
      await c.snapshot('stopped-local-paused');
      await c.resumeOnce();
    });
  });
