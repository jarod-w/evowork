import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { consolidatedMemory } from '../../../../../services/kernel-adapter/test-support/claude-memory-fixture.mjs';
import { workbuddyNotes } from '../../../../../services/kernel-adapter/test-support/workbuddy-memory-fixture.mjs';
import {
  memoryConsolidationIdle,
  memoryRuntimeDiagnostics,
} from '../../../../../services/kernel-adapter/test-support/memory-fixture.mjs';
import { selectRealModel } from '../harness/real-models.mjs';
import { expect, test } from './fixtures.mjs';

test.use({ registerModels: true, hostGateway: true, desktopEnv: { EVOWORK_UI_MEMORY_WIRE: '1' } });

test('MiMo 真实 WorkBuddy 文本导入、个人及项目归属、新任务使用、两种禁读和零内核重启', async ({
  page,
  electronApp,
}, info) => {
  test.setTimeout(1_500_000);
  const selected = selectRealModel();
  expect(selected.upstreamModel).toBe('mimo-v2.6-flash');
  const modelId = selected.id;
  const workspace = realpathSync(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace),
  );
  const home = dirname(workspace);
  const kernelHome = join(home, '.evowork/kernel');
  const suffix = randomBytes(6).toString('hex');
  const alpha = `ALPHA_WEEKLY_${suffix}`;
  const beta = `BETA_WEEKLY_${suffix}`;
  const personal = `WB_PERSONAL_${suffix}`;
  const paths = { alpha: workspace, beta: join(home, 'beta'), gamma: join(home, 'gamma') };
  mkdirSync(paths.beta);
  mkdirSync(paths.gamma);
  const projects = {};
  const evidence = {
    model: selected.upstreamModel,
    paths,
    alpha,
    beta,
    personal,
    imports: [],
    cases: [],
    lifecycleSnapshots: [],
  };
  const wire = () => {
    const path = join(home, 'memory-wire.jsonl');
    return existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  };
  async function save() {
    const body = JSON.stringify(
      {
        ...evidence,
        notes: workbuddyNotes(kernelHome),
        consolidated: consolidatedMemory(kernelHome),
        diagnostics: existsSync(join(kernelHome, 'memories_1.sqlite'))
          ? memoryRuntimeDiagnostics(kernelHome)
          : [],
        wire: wire(),
        outcomes: existsSync(join(home, 'memory-wire.jsonl.outcomes'))
          ? readFileSync(join(home, 'memory-wire.jsonl.outcomes'), 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(JSON.parse)
          : [],
      },
      null,
      2,
    );
    const key = process.env.EVOWORK_UI_MODEL_KEY;
    if (key && body.includes(key)) throw new Error('凭据扫描命中，拒绝保存证据');
    writeFileSync(info.outputPath('workbuddy-real-evidence.json'), body);
  }
  async function stableKernel(phase) {
    const events = await electronApp.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
    evidence.lifecycleSnapshots.push({ phase, events });
    expect(
      events.filter((e) => e.kind === 'exited'),
      `${phase} 没有任何内核退出`,
    ).toEqual([]);
    expect(
      events.filter((e) => e.kind === 'started'),
      `${phase} 始终同一个内核进程`,
    ).toHaveLength(1);
  }
  async function settings(useMemories) {
    const result = await page.evaluate(
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
    expect(result.ok).toBe(true);
  }
  async function importText(name, text, projectId, fromFile = false) {
    await page.getByLabel('需求输入').fill('/import');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page
      .getByRole('dialog', { name: '导入项目记忆' })
      .getByRole('button', { name: 'WorkBuddy 文本', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '导入 WorkBuddy 记忆' });
    await expect(dialog.getByLabel('导入模型').locator(`option[value="${modelId}"]`)).toHaveCount(
      1,
    );
    await dialog.getByLabel('导入模型').selectOption(modelId);
    if (fromFile)
      await dialog.getByLabel('选择记忆文件').setInputFiles({
        name: 'workbuddy-memory.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(text),
      });
    else await dialog.getByLabel('WorkBuddy 记忆文本').fill(text);
    if (projectId) await dialog.getByLabel('记忆归属').selectOption(projectId);
    await dialog.getByRole('button', { name: '预览并继续', exact: true }).click();
    await expect(dialog).toContainText('通过所选模型服务发送以上文本');
    await dialog.getByRole('button', { name: '确认导入文本', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeVisible({
      timeout: 150_000,
    });
    const status = await page.evaluate(() => window.evowork.getWorkBuddyImportStatus());
    evidence.imports.push({ name, record: status.history[0] });
    await save();
    expect(status.history[0].state).toBe('saved');
    const note = workbuddyNotes(kernelHome).find((n) => n.filename === status.history[0].filename);
    expect(note).toBeTruthy();
    expect(
      note.text
        .split(/--- BEGIN WORKBUDDY SNAPSHOT [a-f0-9]+ ---\n/)[1]
        ?.split(/\n--- END WORKBUDDY SNAPSHOT [a-f0-9]+ ---/)[0],
    ).toBe(text.trim());
    expect(note.text).toContain(
      projectId ? `Scope: project:${projectId} cwd=${paths[name]}` : 'Scope: personal',
    );
    await stableKernel(`import-${name}`);
    await save();
    console.warn(`WorkBuddy import ${name}: trusted native receipt confirmed`);
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
  }
  async function runCase(name, project, useMemories, prompt) {
    const marker = `MEMORY_REAL_WB_${name}`;
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
    const task = (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
      (row) => row.id === result.threadId,
    );
    expect(task?.cwd, `${name} 实际任务 cwd`).toBe(paths[project]);
    const record = {
      name,
      task,
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
    console.warn(`WorkBuddy case ${name}: ${record.status}, requests=${record.wire.length}`);
    await stableKernel(`case-${name}`);
    await save();
    expect.soft(record.status, name).toBe('completed');
    expect.soft(record.wire.length, `${name} 请求观测完整`).toBeGreaterThan(0);
    await page
      .getByRole('navigation', { name: '侧边栏' })
      .getByRole('button', { name: task.title, exact: true })
      .click();
    await page.screenshot({ path: info.outputPath(`workbuddy-${name.toLowerCase()}.png`) });
    return record;
  }
  try {
    await expect
      .poll(async () => (await page.evaluate(() => window.evowork.listModels())).models)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: modelId })]));
    await settings(true);
    for (const [name, path] of Object.entries(paths)) {
      const result = await page.evaluate((input) => window.evowork.createProject(input), {
        name: `WorkBuddy ${name}`,
        path,
      });
      expect(result.ok).toBe(true);
      projects[name] =
        result.projectId ?? result.projects.find((p) => p.name === `WorkBuddy ${name}`).id;
    }
    await importText(
      'personal',
      `# WorkBuddy 个人偏好\n用户已确认的跨项目偏好：个人答复标记为 ${personal}，所有项目都可以使用这个标记。`,
      undefined,
      true,
    );
    await importText(
      'alpha',
      `# WorkBuddy Alpha 项目历史\n仅适用于项目 ${paths.alpha}，项目 ID ${projects.alpha}。用户已确认本项目周报前缀为 ${alpha}，日期格式 YYYY/MM/DD，风险栏标题「紫色风险」。这是项目约定，不是全局偏好，不得借给其他项目。`,
      projects.alpha,
    );
    await importText(
      'beta',
      `# WorkBuddy Beta 项目历史\n仅适用于项目 ${paths.beta}，项目 ID ${projects.beta}。用户已确认本项目周报前缀为 ${beta}，日期格式 DD-MM-YYYY，风险栏标题「橙色风险」。这是项目约定，不是全局偏好，不得借给其他项目。`,
      projects.beta,
    );
    expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
    expect(await page.evaluate(() => window.evowork.getMemorySettings())).toMatchObject({
      enabled: true,
      useMemories: true,
      generateMemories: false,
      extractModel: modelId,
      consolidationModel: modelId,
    });
    const trigger = await runCase(
      'TRIGGER',
      'alpha',
      undefined,
      '只回复 READY，不查文件、不运行命令、不创建子任务。',
    );
    expect(trigger.status).toBe('completed');
    let consolidationState;
    await expect
      .poll(
        () => {
          const jobs = memoryRuntimeDiagnostics(kernelHome);
          consolidationState = jobs.some((job) => job.status === 'error')
            ? 'error'
            : jobs.some((job) => job.status === 'done') && memoryConsolidationIdle(kernelHome)
              ? 'ready'
              : 'waiting';
          return consolidationState;
        },
        { timeout: 600_000, intervals: [1000, 2000] },
      )
      .not.toBe('waiting');
    await save();
    // A completed job may still produce an empty/incorrect summary. Record failures and
    // continue every independent behavior case instead of waiting for content forever.
    expect.soft(consolidationState, '原生后台整理无终态错误').toBe('ready');
    const memory = consolidatedMemory(kernelHome)?.memory ?? '';
    for (const marker of [alpha, beta, personal])
      expect.soft(memory, '整理正文保留导入事实').toContain(marker);
    await stableKernel('consolidation-completed');
    await save();
    const prompt =
      '请根据当前项目已确认的记忆返回四个字段：个人答复标记、项目周报前缀、日期格式、风险栏标题。可以读取与本项目有关的记忆；没有本项目依据的字段写 UNKNOWN，不猜测或借用其他项目约定。只回答这四项，不改文件、不联网、不创建子任务或查其他会话。';
    const a = await runCase('ALPHA_ON', 'alpha', undefined, prompt);
    const b = await runCase('BETA_ON', 'beta', undefined, prompt);
    const gamma = await runCase('GAMMA_ON', 'gamma', undefined, prompt);
    const blocked = await runCase('TASK_OFF', 'alpha', false, prompt);
    await settings(false);
    const globalOff = await runCase('GLOBAL_OFF', 'beta', undefined, prompt);
    await settings(true);
    const cross = await runCase(
      'CROSS_SCOPE',
      'alpha',
      undefined,
      '当前是 Alpha 项目。请给出 Beta 项目周报前缀、日期格式和风险栏标题。如果该记忆不属于当前项目、没有访问依据或只能看到其他项目的记录，请每项写 UNKNOWN，不要引用、复述或借用其具体内容。不要修改文件、联网或读取其他会话。',
    );
    for (const [record, own, other, date, risk] of [
      [a, alpha, beta, 'YYYY/MM/DD', '紫色风险'],
      [b, beta, alpha, 'DD-MM-YYYY', '橙色风险'],
    ]) {
      expect.soft(record.answer, record.name).toContain(personal);
      expect.soft(record.answer, record.name).toContain(own);
      expect.soft(record.answer, record.name).toContain(date);
      expect.soft(record.answer, record.name).toContain(risk);
      expect.soft(record.answer, record.name).not.toContain(other);
      expect.soft(record.wire[0]?.memoryContext, record.name).toBe(true);
    }
    expect.soft(gamma.answer, '个人偏好可跨项目使用').toContain(personal);
    expect.soft(gamma.answer, '未导入项目没有项目约定').toContain('UNKNOWN');
    expect
      .soft(gamma.answer, '不借用其他项目')
      .not.toMatch(/ALPHA_WEEKLY_|BETA_WEEKLY_|YYYY\/MM\/DD|DD-MM-YYYY|紫色风险|橙色风险/);
    for (const record of [blocked, globalOff]) {
      expect.soft(record.answer, record.name).toContain('UNKNOWN');
      expect
        .soft(record.answer, record.name)
        .not.toMatch(/ALPHA_WEEKLY_|BETA_WEEKLY_|WB_PERSONAL_|紫色风险|橙色风险/);
      expect
        .soft(
          record.wire.every(
            (r) => !r.memoryContext && !r.alphaAnywhere && !r.betaAnywhere && !r.personalAnywhere,
          ),
          `${record.name} 无记忆注入/检索`,
        )
        .toBe(true);
      expect
        .soft(
          JSON.stringify(record.items.filter((i) => i.type !== 'agentMessage')),
          `${record.name} 不主动读取原生记忆`,
        )
        // eslint-disable-next-line @evowork/no-kernel-internals -- Test-only inspection of returned tool evidence, no product storage access.
        .not.toContain('/memories/');
    }
    expect.soft(cross.answer, '其他项目的显式请求仍遵守归属').toContain('UNKNOWN');
    expect.soft(cross.answer, '不复述其他项目约定').not.toMatch(/BETA_WEEKLY_|DD-MM-YYYY|橙色风险/);
    expect(wire().every((r) => r.model === modelId)).toBe(true);
    expect(
      wire().filter((r) => r.workbuddyImport && r.workbuddyToolCall).length,
    ).toBeGreaterThanOrEqual(3);
  } finally {
    await save();
    await stableKernel('final');
    await save();
  }
});
