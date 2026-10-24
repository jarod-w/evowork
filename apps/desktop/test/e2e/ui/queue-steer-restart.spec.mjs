import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from './fixtures.mjs';
import { kernelProvenanceProblem } from '../../../../../scripts/kernel-provenance.mjs';
import { removeE2EHome } from '../harness/runner.mjs';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../../../..');
const input = (page) => page.getByLabel('需求输入');
const queue = (page) => page.getByLabel('排队中的追问');
const composer = (page) => page.getByLabel('输入区');

async function journey(info, run) {
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
    ok = false;
  const boots = [];
  async function launch() {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [join(root, 'apps/desktop/test/e2e/harness/ui-entry.mjs')],
      cwd: root,
      env: {
        ...parentEnv,
        EVOWORK_E2E_REPO_ROOT: root,
        EVOWORK_APP_SERVER: binary,
        EVOWORK_UI_DELIVERY_RPC_FAULT: '1',
        ...(home ? { EVOWORK_UI_REUSE_HOME: home } : {}),
      },
      timeout: 120000,
    });
    page = await app.firstWindow();
    await expect
      .poll(() => app.evaluate(() => globalThis.__evoworkE2E?.ready === true), { timeout: 120000 })
      .toBe(true);
    await expect(input(page)).toBeVisible();
    await expect(page.getByLabel('选择模型')).toContainText('e2e-model');
    home ??= await app.evaluate(() => globalThis.__evoworkE2E.home);
    boots.push({
      electronPid: app.process().pid,
      lifecycle: await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle()),
    });
  }
  const controls = {
    get app() {
      return app;
    },
    get page() {
      return page;
    },
    async reboot(crash = false) {
      boots[0].exitKind = crash ? 'SIGKILL' : 'closed';
      boots[0].lifecycle = await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
      await page.screenshot({ path: info.outputPath('before-restart.png') });
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
    async snapshot(label) {
      const tasks = (await page.evaluate(() => window.evowork.getStartup())).tasks;
      const histories = await Promise.all(
        tasks.map((task) =>
          page.evaluate((threadId) => window.evowork.openTask({ threadId }), task.id),
        ),
      );
      const faults = await app.evaluate(() => globalThis.__evoworkE2E.deliveryFaults.snapshot());
      const lifecycle = await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
      expect(lifecycle.filter((event) => event.kind === 'exited')).toHaveLength(0);
      writeFileSync(
        info.outputPath(`${label}.json`),
        JSON.stringify(
          {
            boots,
            histories,
            faults,
            lifecycle,
            state: await app.evaluate(() => {
              const db = globalThis.__evoworkE2E.host.store.db;
              return {
                queued: db.prepare('SELECT count(*) AS n FROM follow_up_queue').get().n,
                paused: db
                  .prepare('SELECT count(*) AS n FROM follow_up_control WHERE paused = 1')
                  .get().n,
                pendingComposer: db.prepare('SELECT count(*) AS n FROM follow_up_composer').get().n,
                receipts: db.prepare('SELECT count(*) AS n FROM follow_up_receipt').get().n,
              };
            }),
          },
          null,
          2,
        ),
      );
      await page.screenshot({ path: info.outputPath(`${label}.png`) });
      return { histories, faults };
    },
  };
  try {
    await launch();
    await run(controls);
    ok = true;
  } finally {
    if (app) await app.close();
    if (ok && home) removeE2EHome(home);
  }
}
async function arm(c, method, kind, persistent = false) {
  await c.app.evaluate(
    (_, args) => globalThis.__evoworkE2E.deliveryFaults.arm(...args),
    [method, kind, persistent],
  );
}
async function hold(c, marker) {
  await c.app.evaluate(
    (_, text) =>
      globalThis.__evoworkE2E.gateway.scriptWhen(
        `restart-${text}`,
        (view) => view.text.includes(text),
        { kind: 'hold' },
      ),
    marker,
  );
}
async function begin(c) {
  await hold(c, '重启验证原任务');
  await input(c.page).fill('重启验证原任务');
  await input(c.page).press('Enter');
  await expect
    .poll(() => c.app.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
  await expect(composer(c.page)).toHaveAttribute('data-run-state', 'running');
}
async function selectOriginal(c) {
  await c.page
    .getByRole('navigation', { name: '侧边栏' })
    .getByRole('button', { name: '重启验证原任务', exact: true })
    .click();
  await expect(composer(c.page)).toHaveAttribute('data-run-state', 'idle');
}
async function expectNoAutomaticRequests(c) {
  await new Promise((resolve) => setTimeout(resolve, 2200));
  expect(await c.app.evaluate(() => globalThis.__evoworkE2E.gateway.requestBodies.length)).toBe(0);
}
const userItems = (history, marker) =>
  history.items.filter(
    (item) => item.type === 'userMessage' && JSON.stringify(item).includes(marker),
  );
function expectNoWrites(faults) {
  for (const method of [
    'thread/start',
    'turn/start',
    'turn/steer',
    'thread/queue/add',
    'thread/queue/start',
  ])
    expect(faults.counts[method] ?? 0, method).toBe(0);
}

for (const first of [false, true])
  test(`完整重启：${first ? '首轮' : '追问'}已接受但 IPC 回执丢失，恢复原身份重试不重投`, async ({
    playwright: _,
  }, info) => {
    await journey(info, async (c) => {
      if (!first) await begin(c);
      await c.app.evaluate(() => {
        const actions = globalThis.__evoworkE2E.host.actions;
        const original = actions.send.bind(actions);
        actions.send = async (payload) => {
          const result = await original(payload);
          globalThis.__evoworkE2E.acceptedBeforeLostIpc = result;
          return new Promise(() => {});
        };
      });
      const marker = first ? 'FIRST-ACCEPTED-ONCE' : 'FOLLOWUP-ACCEPTED-ONCE';
      await input(c.page).fill(marker);
      await input(c.page).press('Enter');
      await expect
        .poll(() => c.app.evaluate(() => Boolean(globalThis.__evoworkE2E.acceptedBeforeLostIpc)))
        .toBe(true);
      if (!first) {
        await c.page.getByRole('button', { name: '停止', exact: true }).click();
        await expect(composer(c.page)).toHaveAttribute('data-run-state', 'idle');
      }
      await c.reboot(true);
      await expect(input(c.page)).toHaveValue(marker);
      await input(c.page).press('Enter');
      await expect(input(c.page)).toHaveValue('');
      expect(await c.page.evaluate(() => window.evowork.getPendingSend())).toBeUndefined();
      const result = await c.snapshot('accepted-receipt-restored');
      expectNoWrites(result.faults);
      expect(result.histories).toHaveLength(1);
      if (first) expect(userItems(result.histories[0], marker)).toHaveLength(1);
      else {
        await expect(queue(c.page)).toContainText(marker);
        await expectNoAutomaticRequests(c);
      }
    });
  });

test('完整重启：原生接受但回执与核对失败，停止意图在加载任务前接管队列', async ({
  playwright: _,
}, info) => {
  await journey(info, async (c) => {
    await begin(c);
    await arm(c, 'thread/queue/add', 'drop-response');
    await arm(c, 'thread/queue/list', 'reject', true);
    await input(c.page).fill('UNKNOWN-NATIVE-ACCEPTED');
    await input(c.page).press('Enter');
    await expect(c.page.getByText(/发送结果尚未确认/)).toBeVisible();
    await c.page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(composer(c.page)).toHaveAttribute('data-run-state', 'idle');
    await c.reboot(true);
    await expect(input(c.page)).toHaveValue('UNKNOWN-NATIVE-ACCEPTED');
    await expect(queue(c.page)).toContainText('UNKNOWN-NATIVE-ACCEPTED');
    await expectNoAutomaticRequests(c);
    await input(c.page).press('Enter');
    await expect(input(c.page)).toHaveValue('');
    expect(await c.page.evaluate(() => window.evowork.getPendingSend())).toBeUndefined();
    const before = await c.snapshot('unknown-native-reconciled');
    expectNoWrites(before.faults);
    await c.page.getByRole('button', { name: '继续队列', exact: true }).click();
    await expect(queue(c.page)).toHaveCount(0);
    await expect(composer(c.page)).toHaveAttribute('data-run-state', 'idle');
    const after = await c.snapshot('native-resumed-once');
    expect(userItems(after.histories[0], 'UNKNOWN-NATIVE-ACCEPTED')).toHaveLength(1);
    expect(after.histories[0].turns).toHaveLength(2);
  });
});

test('完整重启：无法证明接受的插话继续保留草稿和附件，重试只核对', async ({
  playwright: _,
}, info) => {
  await journey(info, async (c) => {
    await begin(c);
    const path = info.outputPath('kept.txt');
    writeFileSync(path, '真实重启附件');
    await c.app.evaluate((_, path) => {
      globalThis.__evoworkE2E.pickedFiles = [path];
    }, path);
    await c.page.getByRole('button', { name: '添加内容' }).click();
    await c.page.getByRole('menuitem', { name: /添加本地文件/ }).click();
    await expect(c.page.locator('.ew-attachment[data-state="ready"]')).toHaveCount(1);
    await arm(c, 'turn/steer', 'drop-request');
    await c.page.getByRole('button', { name: '本次发送方式', exact: true }).click();
    await c.page.getByRole('menuitem', { name: /立即插话/ }).click();
    await input(c.page).fill('UNKNOWN-STEER-NEVER-REPLAY');
    await input(c.page).press('Enter');
    await expect(c.page.getByText(/发送结果尚未确认/)).toBeVisible();
    await c.page.getByRole('button', { name: '停止', exact: true }).click();
    await c.reboot();
    await expect(input(c.page)).toHaveValue('UNKNOWN-STEER-NEVER-REPLAY');
    await expect(c.page.locator('.ew-attachment')).toHaveCount(1);
    await input(c.page).press('Enter');
    await expect(c.page.getByText(/发送结果尚未确认/)).toBeVisible();
    const after = await c.snapshot('unknown-steer-no-replay');
    expectNoWrites(after.faults);
    expect(userItems(after.histories[0], 'UNKNOWN-STEER-NEVER-REPLAY')).toHaveLength(0);
  });
});

for (const stopped of [false, true])
  test(`完整重启：本机队列${stopped ? '停止后' : '意外退出后'}恢复，编辑顺序与删除保持，明确继续才执行`, async ({
    playwright: _,
  }, info) => {
    await journey(info, async (c) => {
      await begin(c);
      await arm(c, 'thread/queue/add', 'unavailable', true);
      for (const marker of ['LOCAL-A', 'LOCAL-B', 'LOCAL-C']) {
        await input(c.page).fill(marker);
        await input(c.page).press('Enter');
        await expect(queue(c.page)).toContainText(marker);
      }
      await queue(c.page).getByRole('button', { name: '编辑排队项：LOCAL-B' }).click();
      await c.page.getByRole('textbox', { name: '排队项内容' }).fill('LOCAL-B-EDITED');
      await c.page.getByRole('button', { name: '保存', exact: true }).click();
      await queue(c.page).getByRole('button', { name: '上移排队项：LOCAL-B-EDITED' }).click();
      await queue(c.page).getByRole('button', { name: '删除排队项：LOCAL-C' }).click();
      if (stopped) {
        await c.page.getByRole('button', { name: '停止', exact: true }).click();
        await expect(composer(c.page)).toHaveAttribute('data-run-state', 'idle');
      }
      await c.reboot(!stopped);
      await selectOriginal(c);
      await expect(queue(c.page).locator('.ew-queue-text')).toHaveText([
        'LOCAL-B-EDITED',
        'LOCAL-A',
      ]);
      await expectNoAutomaticRequests(c);
      await c.snapshot('local-restored-paused');
      await c.page.getByRole('button', { name: '继续队列', exact: true }).click();
      await expect(queue(c.page)).toHaveCount(0);
      await expect(composer(c.page)).toHaveAttribute('data-run-state', 'idle');
      const after = await c.snapshot('local-restored-executed');
      expect(after.histories[0].turns).toHaveLength(3);
      const messages = after.histories[0].items
        .filter((item) => item.type === 'userMessage')
        .map((item) => JSON.stringify(item));
      expect(messages.findIndex((text) => text.includes('LOCAL-B-EDITED'))).toBeLessThan(
        messages.findIndex((text) => text.includes('LOCAL-A')),
      );
      expect(userItems(after.histories[0], 'LOCAL-A')).toHaveLength(1);
      expect(userItems(after.histories[0], 'LOCAL-B-EDITED')).toHaveLength(1);
      expect(userItems(after.histories[0], 'LOCAL-C')).toHaveLength(0);
    });
  });

test('完整重启：本机队列出队已接受但回执丢失，恢复核对后不再次启动回合', async ({
  playwright: _,
}, info) => {
  await journey(info, async (c) => {
    await begin(c);
    await arm(c, 'thread/queue/add', 'unavailable', true);
    await input(c.page).fill('LOCAL-DISPATCH-ONCE');
    await input(c.page).press('Enter');
    await expect(queue(c.page)).toContainText('LOCAL-DISPATCH-ONCE');
    await c.page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(composer(c.page)).toHaveAttribute('data-run-state', 'idle');
    await hold(c, 'LOCAL-DISPATCH-ONCE');
    await arm(c, 'turn/start', 'drop-response');
    await c.page.getByRole('button', { name: '继续队列', exact: true }).click();
    await expect
      .poll(() => c.app.evaluate(() => globalThis.__evoworkE2E.deliveryFaults.snapshot().dropped))
      .toBe(1);
    await expect(c.page.getByText(/没能继续队列/)).toBeVisible();
    await c.reboot(true);
    await selectOriginal(c);
    await expectNoAutomaticRequests(c);
    await expect(queue(c.page)).toContainText('LOCAL-DISPATCH-ONCE');
    await c.page.getByRole('button', { name: '继续队列', exact: true }).click();
    await expect(queue(c.page)).toHaveCount(0);
    const after = await c.snapshot('dispatch-reconciled-after-crash');
    expectNoWrites(after.faults);
    expect(userItems(after.histories[0], 'LOCAL-DISPATCH-ONCE')).toHaveLength(1);
    expect(after.histories[0].turns).toHaveLength(2);
  });
});
