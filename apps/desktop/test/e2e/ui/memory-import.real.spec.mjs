import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  consolidatedMemory,
  importedMemory,
  seedClaudeMemory,
} from '../../../../../services/kernel-adapter/test-support/claude-memory-fixture.mjs';
import {
  memoryConsolidationIdle,
  memoryRuntimeDiagnostics,
} from '../../../../../services/kernel-adapter/test-support/memory-fixture.mjs';
import { selectRealModel } from '../harness/real-models.mjs';
import { expect, test } from './fixtures.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: { EVOWORK_UI_MEMORY_WIRE: '1' },
});

test('真模型导入后使用、任务/全局禁读和三个项目的范围约束', async ({ page, electronApp }, info) => {
  test.setTimeout(1_200_000);
  const workspace = realpathSync(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace),
  );
  const home = dirname(workspace);
  const kernelHome = join(home, '.evowork', 'kernel');
  const suffix = randomBytes(6).toString('hex');
  const alpha = `ALPHA_WEEKLY_${suffix}`;
  const beta = `BETA_WEEKLY_${suffix}`;
  const paths = { alpha: workspace, beta: join(home, 'beta'), gamma: join(home, 'gamma') };
  seedClaudeMemory(
    home,
    paths.alpha,
    'alpha-project',
    `# Alpha 项目记忆\n仅适用于项目 ${paths.alpha}，不得应用到任何其他项目。\n` +
      `已经由用户确认：本项目周报必须以 ${alpha}_OLD 开头；日期用 YYYY/MM/DD；风险栏标题为「紫色风险」。\n` +
      '这是项目约定，不是用户全局偏好。\n',
  );
  seedClaudeMemory(
    home,
    paths.beta,
    'beta-project',
    `# Beta 项目记忆\n仅适用于项目 ${paths.beta}，不得应用到任何其他项目。\n` +
      `已经由用户确认：本项目周报必须以 ${beta} 开头；日期用 DD-MM-YYYY；风险栏标题为「橙色风险」。\n` +
      '这是项目约定，不是用户全局偏好。\n',
  );
  mkdirSync(paths.gamma);
  const modelId = selectRealModel().id;
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.listModels())).models)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: modelId })]));
  const settings = (useMemories) =>
    page.evaluate(
      ({ modelId, useMemories }) =>
        window.evowork.setMemorySettings({
          enabled: true,
          useMemories,
          generateMemories: false,
          extractModel: modelId,
          consolidationModel: modelId,
        }),
      { modelId, useMemories },
    );
  expect((await settings(true)).ok).toBe(true);
  const projects = {};
  for (const [name, path] of Object.entries(paths)) {
    const result = await page.evaluate((input) => window.evowork.createProject(input), {
      name: `Memory ${name}`,
      path,
    });
    expect(result.ok).toBe(true);
    projects[name] =
      result.projectId ?? result.projects.find((p) => p.name === `Memory ${name}`).id;
  }
  await page.getByLabel('需求输入').fill('/import');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入项目记忆' });
  await dialog.getByRole('button', { name: '检测项目', exact: true }).click();
  for (const name of ['alpha', 'beta'])
    await dialog.getByRole('checkbox', { name: new RegExp(`${name}-project`) }).check();
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  for (const name of ['alpha', 'beta']) {
    await expect(dialog.getByText(`${name}-project：资料已导入`)).toBeVisible();
    expect(importedMemory(kernelHome, `${name}-project`).scope.cwd).toBe(paths[name]);
  }
  await dialog.getByRole('button', { name: '完成', exact: true }).click();

  // Update the authorized native copy through the production sync UI before model consolidation.
  const sourcePath = join(home, '.claude/projects/alpha-project/memory/MEMORY.md');
  writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace(`${alpha}_OLD`, alpha));
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page
    .getByRole('menu', { name: '用户菜单' })
    .getByRole('menuitem', { name: '设置', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '记忆与导入', exact: true })
    .click();
  const sync = page.getByLabel('记忆自动同步');
  await sync.getByRole('checkbox').check();
  await expect
    .poll(() => importedMemory(kernelHome, 'alpha-project')?.text)
    .not.toContain(`${alpha}_OLD`);
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getMemoryImportHistory())).length)
    .toBe(2);
  await expect
    .poll(
      async () => (await page.evaluate(() => window.evowork.getMemoryImportStatus())).sync?.pending,
    )
    .toBeUndefined();
  await sync.getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const evidence = {
    model: selectRealModel().upstreamModel,
    paths,
    alpha,
    beta,
    automaticSync: true,
    cases: [],
  };
  const wire = () => {
    const path = join(home, 'memory-wire.jsonl');
    return existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  };
  async function saveEvidence() {
    const body = JSON.stringify(
      {
        ...evidence,
        consolidated: consolidatedMemory(kernelHome),
        diagnostics: memoryRuntimeDiagnostics(kernelHome),
        wire: wire(),
      },
      null,
      2,
    );
    const key = process.env.EVOWORK_UI_MODEL_KEY;
    if (key && body.includes(key)) throw new Error('测试证据中发现凭据，拒绝写盘');
    const path = info.outputPath('memory-real-evidence.json');
    writeFileSync(path, body);
    await info.attach('memory-real-evidence', { path, contentType: 'application/json' });
  }
  async function runCase(name, project, useMemories, prompt) {
    const marker = `MEMORY_REAL_${name}`;
    const result = await page.evaluate((input) => window.evowork.send(input), {
      workspaceId: projects[project],
      modelId,
      text: `${marker}\n${prompt}`,
      ...(useMemories === undefined ? {} : { useMemories }),
    });
    expect(result.threadId).toBeTruthy();
    let history;
    await expect
      .poll(
        async () => {
          history = await page.evaluate(
            (threadId) => window.evowork.openTask({ threadId }),
            result.threadId,
          );
          return history.turns?.at(-1)?.status ?? 'waiting';
        },
        { timeout: 180_000, intervals: [500, 1000, 2000] },
      )
      .not.toMatch(/^(waiting|inProgress)$/);
    const answer = history.items
      .filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary')
      .map((item) => item.text)
      .join('\n');
    const record = {
      name,
      project,
      useMemories,
      threadId: result.threadId,
      status: history.turns.at(-1).status,
      failure: history.turnFailure,
      answer,
      items: history.items,
      wire: wire().filter((r) => r.cases.includes(marker)),
    };
    evidence.cases.push(record);
    console.warn(`Memory case ${name}: ${record.status}, requests=${record.wire.length}`);
    await saveEvidence();
    await page
      .getByRole('navigation', { name: '侧边栏' })
      .getByRole('button', { name: marker, exact: true })
      .click();
    const expected =
      name === 'TRIGGER'
        ? 'READY'
        : name === 'ALPHA_ON'
          ? alpha
          : name === 'BETA_ON'
            ? beta
            : 'UNKNOWN';
    // 一个回合可有多条助手消息；仍只认可见的助手回复，不能命中用户提示中的 UNKNOWN。
    await expect
      .soft(page.getByRole('feed').locator('.ew-item-agent').filter({ hasText: expected }).first())
      .toBeVisible();
    await page.screenshot({ path: info.outputPath(`memory-${name.toLowerCase()}.png`) });
    expect.soft(record.status, name).toBe('completed');
    expect.soft(record.wire.length, `${name} 请求观测完整`).toBeGreaterThan(0);
    return record;
  }

  try {
    const trigger = await runCase(
      'TRIGGER',
      'alpha',
      undefined,
      '请只回复 READY。不读文件，不运行命令，不创建子任务。',
    );
    expect(trigger.status, '前置真实模型回合完成').toBe('completed');
    await expect
      .poll(
        () => {
          const data = consolidatedMemory(kernelHome);
          return (
            !!data &&
            data.summary.length > 50 &&
            data.memory.length > 50 &&
            memoryConsolidationIdle(kernelHome)
          );
        },
        { timeout: 600_000, intervals: [1000, 2000] },
      )
      .toBe(true);
    await saveEvidence();
    const prompt =
      '请按本项目已有的周报约定，返回开头标签、日期格式、风险栏标题。可以查阅本项目相关记忆；没有本项目依据的字段写 UNKNOWN，不得猜测或借用其他项目约定。只回答这三个字段，不修改文件，不联网，不创建子任务或读取其他会话。';
    const a = await runCase('ALPHA_ON', 'alpha', undefined, prompt);
    const b = await runCase('BETA_ON', 'beta', undefined, prompt);
    const blocked = await runCase('ALPHA_OFF', 'alpha', false, prompt);
    const unknown = await runCase('GAMMA_ON', 'gamma', undefined, prompt);
    expect((await settings(false)).ok).toBe(true);
    const globalOff = await runCase('GLOBAL_OFF', 'beta', undefined, prompt);
    for (const [record, own, other, date, risk] of [
      [a, alpha, beta, 'YYYY/MM/DD', '紫色风险'],
      [b, beta, alpha, 'DD-MM-YYYY', '橙色风险'],
    ]) {
      expect.soft(record.answer, record.name).toContain(own);
      expect.soft(record.answer, record.name).toContain(date);
      expect.soft(record.answer, record.name).toContain(risk);
      expect.soft(record.answer, record.name).not.toContain(other);
      expect.soft(record.wire[0]?.memoryContext, record.name).toBe(true);
    }
    for (const record of [blocked, globalOff]) {
      expect.soft(record.answer, record.name).toContain('UNKNOWN');
      expect
        .soft(record.answer, record.name)
        .not.toMatch(/ALPHA_WEEKLY_|BETA_WEEKLY_|紫色风险|橙色风险/);
      expect
        .soft(
          record.wire.every((r) => !r.memoryContext && !r.alphaAnywhere && !r.betaAnywhere),
          `${record.name} 未注入/读取记忆`,
        )
        .toBe(true);
      expect
        .soft(
          JSON.stringify(record.items.filter((i) => i.type !== 'agentMessage')),
          `${record.name} 没有主动读取记忆`,
        )
        // eslint-disable-next-line @evowork/no-kernel-internals -- Test-only assertion on returned tool evidence, no storage access.
        .not.toContain('/memories/');
    }
    expect.soft(a.answer, '使用自动同步后的版本').not.toContain(`${alpha}_OLD`);
    expect.soft(unknown.answer, '未导入项目不借用其他项目约定').toContain('UNKNOWN');
    expect
      .soft(unknown.answer, '未导入项目不借用其他项目约定')
      .not.toMatch(/ALPHA_WEEKLY_|BETA_WEEKLY_|紫色风险|橙色风险|YYYY\/MM\/DD|DD-MM-YYYY/);
  } finally {
    await saveEvidence();
  }
});
