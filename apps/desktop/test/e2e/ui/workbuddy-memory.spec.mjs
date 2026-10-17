import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { test, expect } from './fixtures.mjs';
import { resizeWindow, horizontalOverflow } from './assertions.mjs';
import {
  workbuddyNotes,
  workbuddyConsolidationCommand,
} from '../../../../../services/kernel-adapter/test-support/workbuddy-memory-fixture.mjs';
import { memoryRuntimeDiagnostics } from '../../../../../services/kernel-adapter/test-support/memory-fixture.mjs';
import { consolidatedMemory } from '../../../../../services/kernel-adapter/test-support/claude-memory-fixture.mjs';

async function fixture(electronApp) {
  const workspace = realpathSync(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace),
  );
  return { workspace, kernelHome: join(dirname(workspace), '.evowork/kernel') };
}
async function open(page) {
  await page.getByLabel('需求输入').fill('/import');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page
    .getByRole('dialog', { name: '导入项目记忆' })
    .getByRole('button', { name: 'WorkBuddy 文本', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '导入 WorkBuddy 记忆' });
  await expect(dialog.getByLabel('导入模型')).not.toHaveValue('');
  return dialog;
}
async function installModel(electronApp, name = 'write', hold = false) {
  await electronApp.evaluate(
    (_, { name, hold }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      if (hold) {
        gateway.scriptWhen(name, (v) => v.text.includes('WORKBUDDY_TEXT_IMPORT_V1'), {
          kind: 'hold',
          text: 'Waiting for native memory save.',
        });
        return;
      }
      const script = { tool: 'add_ad_hoc_note', args: {} };
      gateway.scriptWhen(
        name,
        (v) => {
          if (!v.text.includes('WORKBUDDY_TEXT_IMPORT_V1') || v.calls.includes('add_ad_hoc_note'))
            return false;
          const values = [];
          const visit = (x) => {
            if (typeof x === 'string') values.push(x);
            else if (x && typeof x === 'object') Object.values(x).forEach(visit);
          };
          visit(JSON.parse(v.text).input);
          const prompt = values.find((s) => s.startsWith('WORKBUDDY_TEXT_IMPORT_V1\n'));
          script.args = JSON.parse(prompt.split('\n').at(-1));
          return true;
        },
        script,
      );
      gateway.scriptWhen(
        name + '-done',
        (v) => v.text.includes('WORKBUDDY_TEXT_IMPORT_V1') && v.calls.includes('add_ad_hoc_note'),
        { kind: 'text', text: 'Memory saved.' },
      );
    },
    { name, hold },
  );
}
async function submit(dialog, text) {
  await dialog.getByLabel('WorkBuddy 记忆文本').fill(text);
  await dialog.getByRole('button', { name: '预览并继续', exact: true }).click();
  await expect(dialog).toContainText('通过所选模型服务发送以上文本');
  await dialog.getByRole('button', { name: '确认导入文本', exact: true }).click();
}

test('WorkBuddy 文本和文件预览取消零提交，个人/项目保存、去重、设置历史及窄窗', async ({
  page,
  electronApp,
}, info) => {
  const f = await fixture(electronApp);
  await page.evaluate(() =>
    window.evowork.setMemorySettings({
      enabled: false,
      useMemories: false,
      generateMemories: false,
    }),
  );
  let dialog = await open(page);
  await dialog.getByLabel('选择记忆文件').setInputFiles({
    name: 'memory.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Personal\nUse violet reports. <script>BAD_IMPORT_SCRIPT</script>'),
  });
  await expect(dialog.getByLabel('WorkBuddy 记忆文本')).toHaveValue(/Use violet/);
  await dialog.getByRole('button', { name: '预览并继续' }).click();
  await page.keyboard.press('Escape');
  expect(workbuddyNotes(f.kernelHome)).toEqual([]);
  expect((await page.evaluate(() => window.evowork.getWorkBuddyImportStatus())).history).toEqual(
    [],
  );
  expect(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.requestBodies.length),
  ).toBe(0);
  dialog = await open(page);
  await installModel(electronApp);
  await submit(dialog, 'Personal preference: use violet reports.');
  await expect(dialog.getByRole('status').filter({ hasText: '资料已保存' })).toBeVisible();
  expect(workbuddyNotes(f.kernelHome)).toHaveLength(1);
  await expect(page.locator('.ew-toast[data-tone="danger"]')).toHaveCount(0);
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
  expect(workbuddyNotes(f.kernelHome)[0].text).toContain('Scope: personal');
  expect(await page.evaluate(() => window.evowork.getMemorySettings())).toMatchObject({
    enabled: false,
    useMemories: false,
    generateMemories: false,
  });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  const requests = await electronApp.evaluate(
    () => globalThis.__evoworkE2E.gateway.requestBodies.length,
  );
  dialog = await open(page);
  await submit(dialog, '\uFEFF Personal preference: use violet reports.\r\n');
  await expect(dialog).toContainText('本次没有重复提交');
  expect(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.requestBodies.length),
  ).toBe(requests);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  dialog = await open(page);
  const projectId = await dialog
    .getByLabel('记忆归属')
    .locator('option')
    .nth(1)
    .getAttribute('value');
  await dialog.getByLabel('记忆归属').selectOption(projectId);
  await installModel(electronApp, 'project-write');
  await submit(dialog, 'Personal preference: use violet reports.');
  await expect(dialog.getByRole('status').filter({ hasText: '资料已保存' })).toBeVisible();
  expect(workbuddyNotes(f.kernelHome)).toHaveLength(2);
  expect(
    workbuddyNotes(f.kernelHome).some((n) =>
      n.text.includes(`Scope: project:${projectId} cwd=${f.workspace}`),
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('workbuddy-result.png') });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '导入', exact: true })
    .click();
  await expect(page.getByLabel('WorkBuddy 导入历史')).toContainText('个人偏好');
  await page.getByRole('button', { name: '导入已有记忆', exact: true }).click();
  await page.getByRole('button', { name: 'WorkBuddy 文本', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入 WorkBuddy 记忆' });
  await resizeWindow(electronApp, 480, 760);
  expect(await horizontalOverflow(page)).toBe(0);
  await page.screenshot({ path: info.outputPath('workbuddy-480.png') });
  await page.keyboard.press('Escape');
  await page.reload();
  expect(
    (await page.evaluate(() => window.evowork.getWorkBuddyImportStatus())).history,
  ).toHaveLength(2);
  expect(
    JSON.stringify((await page.evaluate(() => window.evowork.getWorkBuddyImportStatus())).history),
  ).not.toContain('violet');
});

async function verifyConsolidation(page, electronApp, injectRetry = false) {
  const f = await fixture(electronApp);
  const dialog = await open(page);
  await installModel(electronApp);
  const model = await dialog.getByLabel('导入模型').inputValue();
  await submit(dialog, 'Personal preference: use violet reports. WORKBUDDY_NATIVE_EVIDENCE');
  await expect(dialog.getByRole('status').filter({ hasText: '资料已保存' })).toBeVisible();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.evaluate(
    (model) =>
      window.evowork.setMemorySettings({
        enabled: true,
        useMemories: true,
        generateMemories: false,
        consolidationModel: model,
      }),
    model,
  );
  await electronApp.evaluate(
    (_, { cmd, injectRetry }) => {
      const g = globalThis.__evoworkE2E.gateway;
      if (injectRetry)
        g.scriptWhen(
          'wb-consolidation-503',
          (v) => v.text.includes('## Memory Writing Agent: Phase 2 (Consolidation)'),
          {
            kind: 'fail',
            code: 'upstream_disconnected',
            text: 'Synthetic MiMo ServiceUnavailableError 503',
          },
        );
      g.scriptWhen(
        'wb-consolidation',
        (v) => v.text.includes('phase2_workspace_diff.md') && !v.calls.includes('exec_command'),
        { tool: 'exec_command', args: { cmd } },
      );
      g.scriptWhen('wb-consolidation-done', (v) => v.text.includes('WORKBUDDY_EVIDENCE_READ'), {
        kind: 'text',
        text: 'WorkBuddy notes consolidated.',
      });
    },
    { cmd: workbuddyConsolidationCommand, injectRetry },
  );
  const project = (await page.evaluate(() => window.evowork.listProjects())).projects[0].id;
  const send = (text, useMemories) =>
    page.evaluate(
      ({ text, useMemories, project, model }) =>
        window.evowork.send({
          text,
          workspaceId: project,
          modelId: model,
          ...(useMemories === undefined ? {} : { useMemories }),
        }),
      { text, useMemories, project, model },
    );
  await send('WB_TRIGGER_CONSOLIDATION');
  await expect
    .poll(() => consolidatedMemory(f.kernelHome)?.memory, { timeout: 60000 })
    .toContain('WORKBUDDY_NATIVE_EVIDENCE');
  await expect
    .poll(() =>
      electronApp.evaluate(() =>
        globalThis.__evoworkE2E.gateway.matchedBody('wb-consolidation-done'),
      ),
    )
    .toContain('WORKBUDDY_NATIVE_EVIDENCE');
  await expect
    .poll(() => memoryRuntimeDiagnostics(f.kernelHome), { timeout: 30000 })
    .toEqual([expect.objectContaining({ status: 'done', last_error: null, retry_remaining: 3 })]);
  await send('WB_NEW_TASK');
  await expect
    .poll(() =>
      electronApp.evaluate(() =>
        globalThis.__evoworkE2E.gateway.requestBodies.find((b) => b.includes('WB_NEW_TASK')),
      ),
    )
    .toContain('WorkBuddy preference');
  await send('WB_DISABLED_TASK', false);
  await expect
    .poll(() =>
      electronApp.evaluate(
        () =>
          globalThis.__evoworkE2E.gateway.requestBodies.filter((b) =>
            b.includes('WB_DISABLED_TASK'),
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  expect(
    await electronApp.evaluate(() =>
      globalThis.__evoworkE2E.gateway.requestBodies
        .filter((b) => b.includes('WB_DISABLED_TASK'))
        .every((b) => !b.includes('WorkBuddy preference')),
    ),
  ).toBe(true);
  if (injectRetry)
    expect(
      await electronApp.evaluate(() =>
        globalThis.__evoworkE2E.gateway.matchedBody('wb-consolidation-503'),
      ),
    ).toBeTruthy();
  const lifecycle = await electronApp.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
  expect(lifecycle.filter((e) => e.kind === 'started')).toHaveLength(1);
  expect(lifecycle.filter((e) => e.kind === 'exited')).toEqual([]);
}

test('原生 note 后续整理进入新任务，禁读不注入，无内核重启', async ({ page, electronApp }) => {
  await verifyConsolidation(page, electronApp);
});

test.describe('后台整理瞬时故障恢复', () => {
  test.use({ desktopEnv: { EVOWORK_UI_NATIVE_RETRIES: '2' } });
  test('503 后同一整理作业重试成功、记忆进入新任务且不重启内核', async ({ page, electronApp }) => {
    await verifyConsolidation(page, electronApp, true);
  });
});

test('模型只声称成功仍显示未确认，重复提交不重放', async ({ page, electronApp }) => {
  const f = await fixture(electronApp);
  let dialog = await open(page);
  await submit(dialog, 'LIAR_MODEL_EVIDENCE');
  await expect(dialog.getByRole('alert')).toContainText('结果未确认');
  expect(workbuddyNotes(f.kernelHome)).toHaveLength(0);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  const requests = await electronApp.evaluate(
    () => globalThis.__evoworkE2E.gateway.requestBodies.length,
  );
  dialog = await open(page);
  await submit(dialog, 'LIAR_MODEL_EVIDENCE');
  await expect(dialog).toContainText('本次没有重复提交');
  expect(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.requestBodies.length),
  ).toBe(requests);
});

test('导入中主动终止测试内核，恢复后未知批次不重放', async ({ page, electronApp }) => {
  const dialog = await open(page);
  await installModel(electronApp, 'held', true);
  await dialog.getByLabel('WorkBuddy 记忆文本').fill('INTERRUPTED_WORKBUDDY_IMPORT');
  await dialog.getByRole('button', { name: '预览并继续' }).click();
  await dialog.getByRole('button', { name: '确认导入文本' }).click();
  await expect
    .poll(() => electronApp.evaluate(() => !!globalThis.__evoworkE2E.gateway.matchedBody('held')))
    .toBe(true);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
  await expect(dialog.getByRole('alert')).toContainText('结果未确认');
  await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
    timeout: 60000,
  });
  expect(
    (await page.evaluate(() => window.evowork.getWorkBuddyImportStatus())).history[0].state,
  ).toBe('unknown');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  const before = await electronApp.evaluate(
    () => globalThis.__evoworkE2E.gateway.requestBodies.length,
  );
  const again = await open(page);
  await submit(again, 'INTERRUPTED_WORKBUDDY_IMPORT');
  await expect(again).toContainText('本次没有重复提交');
  expect(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.requestBodies.length),
  ).toBe(before);
});

test('拒绝无效 UTF-8、超大文件和不可用模型，预览不执行 HTML', async ({ page }) => {
  const dialog = await open(page);
  await dialog
    .getByLabel('选择记忆文件')
    .setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from([0xff, 0xfe]) });
  await expect(dialog.getByRole('alert')).toContainText('UTF-8');
  await dialog
    .getByLabel('选择记忆文件')
    .setInputFiles({ name: 'large.md', mimeType: 'text/plain', buffer: Buffer.alloc(65537, 65) });
  await expect(dialog.getByRole('alert')).toContainText('64 KiB');
  await dialog
    .getByLabel('WorkBuddy 记忆文本')
    .fill('<img src=x onerror="window.BAD_IMPORT_SCRIPT=1">');
  await dialog.getByRole('button', { name: '预览并继续' }).click();
  expect(await page.evaluate(() => window.BAD_IMPORT_SCRIPT)).toBeUndefined();
  await expect(
    page.evaluate(() =>
      window.evowork.importWorkBuddyText({ text: 'model invalid', model: 'unavailable' }),
    ),
  ).rejects.toThrow();
  expect(
    (await page.evaluate(() => window.evowork.getWorkBuddyImportStatus())).history,
  ).toHaveLength(0);
});
