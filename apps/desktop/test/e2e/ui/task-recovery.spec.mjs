/** 真窗口与真内核；假上游控制崩溃时机，磁盘后果验证不会自动重做。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

test('长任务写入后崩溃：历史恢复、刷新仍可继续、文件不重复写入', async ({ page, electronApp }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const saved = join(workspace, 'recovery-checkpoint.txt');
  const marker = `RECOVERY-${Date.now()}`;
  await electronApp.evaluate(
    (_electron, { marker, cmd }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      gateway.scriptWhen(
        'checkpoint',
        (view) => view.text.includes(marker) && !view.calls.includes('exec_command'),
        { tool: 'exec_command', args: { cmd } },
      );
      gateway.scriptWhen(
        'hold-after-write',
        (view) => view.text.includes(marker) && view.calls.includes('exec_command'),
        { kind: 'hold' },
      );
    },
    { marker, cmd: `printf 'saved-once\n' >> ${quote(saved)}` },
  );
  await startTaskInWorkspace(page, electronApp, `先保存资料，再完成报告 ${marker}`);
  await expect
    .poll(() => (existsSync(saved) ? readFileSync(saved, 'utf8') : ''))
    .toBe('saved-once\n');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'running');
  await expect
    .poll(() =>
      electronApp.evaluate(() =>
        Boolean(globalThis.__evoworkE2E.gateway.matchedBody('hold-after-write')),
      ),
    )
    .toBe(true);
  const original = await electronApp.evaluate(() => globalThis.__evoworkE2E.kernelPid());
  await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
  await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
    timeout: 60_000,
  });
  expect(await electronApp.evaluate(() => globalThis.__evoworkE2E.kernelPid())).not.toBe(original);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByRole('button', { name: '继续任务' })).toBeEnabled();
  expect(readFileSync(saved, 'utf8')).toBe('saved-once\n');

  // 刷新清掉 React 内存，再从原任务打开权威历史。
  const task = await page.evaluate(async () => (await window.evowork.getStartup()).tasks[0]);
  expect(task?.id).toBeTruthy();
  await page.reload();
  const row = page.getByRole('button', { name: task.title, exact: true });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole('main', { name: '对话区' })).toContainText(marker);
  await expect(page.getByRole('button', { name: '继续任务' })).toBeEnabled();
  await page.getByLabel('需求输入').fill('这条草稿留着');
  await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.scriptWhen(
      'continued',
      (view) => view.text.includes('只执行剩余步骤'),
      { kind: 'text', text: '报告余下部分已完成。' },
    ),
  );
  await page.getByRole('button', { name: '继续任务' }).click();
  await expect(page.getByRole('main', { name: '对话区' })).toContainText('报告余下部分已完成。', {
    timeout: 60_000,
  });
  await expect(page.getByLabel('需求输入')).toHaveValue('这条草稿留着');
  expect(readFileSync(saved, 'utf8')).toBe('saved-once\n');
  const body = await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.matchedBody('continued'),
  );
  expect(body).toContain('recovery-checkpoint.txt');
  expect(body).toContain(marker);
  expect(errors, '恢复过程中出现未处理的渲染层异常').toEqual([]);
});

test('审批期间崩溃：旧审批撤销，未经批准的写入不会在恢复后执行', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const file = join(workspace, 'must-not-be-written.txt');
  await electronApp.evaluate(
    (_electron, script) => globalThis.__evoworkE2E.gateway.scriptNext(script),
    {
      tool: 'exec_command',
      args: {
        cmd: `printf denied > ${quote(file)}`,
        sandbox_permissions: 'require_escalated',
        justification: '恢复验收的受控写入',
      },
    },
  );
  await startTaskInWorkspace(page, electronApp, '等待我批准之后才写入文件');
  await expect(page.getByLabel('需要你确认')).toBeVisible();
  expect(existsSync(file)).toBe(false);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
  await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByLabel('需要你确认')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续任务' })).toBeEnabled();
  expect(existsSync(file)).toBe(false);
});

test.describe('自动化的崩溃恢复', () => {
  test.use({ registerModels: true });
  test('真宿主将运行记录结束为环境失败，不增加连败且释放并发名额', async ({
    page,
    electronApp,
  }) => {
    await electronApp.evaluate(async () => {
      const { host, gateway } = globalThis.__evoworkE2E;
      const definition = {
        id: 'recovery-automation',
        name: '恢复验收自动化',
        prompt: '自动化恢复验收',
        deviceId: host.store.deviceId,
        schedule: '0 0 1 1 *',
        timezone: 'Asia/Shanghai',
        status: 'ACTIVE',
        misfirePolicy: 'DROP',
        catchupWindowMs: 0,
        wakeSystem: false,
        consecutiveFailures: 2,
        budgetLimit: 100_000,
        workspaces: [],
        modelId: 'e2e-model',
      };
      host.services.automations.save(definition, Date.now());
      gateway.scriptWhen('automation-hold', (view) => view.text.includes('自动化恢复验收'), {
        kind: 'hold',
      });
      await host.services.scheduler.fire(definition, Date.now(), 'MANUAL_TEST');
    });
    expect(
      await electronApp.evaluate(() => globalThis.__evoworkE2E.host.services.bridge.runningCount()),
    ).toBe(1);
    await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
    await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
      timeout: 60_000,
    });
    const state = await electronApp.evaluate(() => {
      const { services } = globalThis.__evoworkE2E.host;
      return {
        running: services.bridge.runningCount(),
        automation: services.automations.get('recovery-automation'),
        runs: services.automations.listRuns('recovery-automation'),
      };
    });
    expect(state.running).toBe(0);
    expect(state.automation.consecutiveFailures).toBe(2);
    expect(state.automation.status).toBe('ACTIVE');
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ status: 'FAILED', failure_class: 'ENVIRONMENT' });
  });
});
