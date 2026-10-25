/** Real model output, shipped kernel, bundled MCP, and actual Electron interactions. */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { selectRealModel } from '../harness/real-models.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: {
    EVOWORK_UI_FOLLOW_UP_WIRE: '1',
    EVOWORK_UI_MEMORY_IMPORT: 'disabled',
  },
});
test.setTimeout(600_000);
const startup = (page) => page.evaluate(() => window.evowork.getStartup());
const history = (page, id) =>
  page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
const draftOf = (page, id) =>
  page.evaluate((threadId) => window.evowork.getSkillExtraction({ threadId }), id);
const calls = (h, tool) =>
  h.items.filter(
    (item) => item.type === 'mcpToolCall' && item.server === 'skill_drafts' && item.tool === tool,
  );
const guard = '不要联网、读取环境变量、读取工作目录外的文件或创建子任务。';

async function completed(page, id, count) {
  await expect
    .poll(
      async () => {
        const h = await history(page, id);
        const failed = h.turns.find((turn) => turn.status === 'failed');
        if (failed) throw new Error('真实模型回合失败：' + JSON.stringify(failed));
        const allow = page
          .getByLabel('需要你确认')
          .getByRole('button', { name: '允许这一次', exact: true });
        if (await allow.count())
          await allow
            .first()
            .click({ timeout: 2000 })
            .catch(() => {});
        return h.turns.length === count && h.turns.every((turn) => turn.status === 'completed');
      },
      { timeout: 180_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
}

async function send(page, text) {
  await page.getByLabel('需求输入').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

async function reopen(page, id) {
  const task = (await startup(page)).tasks.find((item) => item.id === id);
  expect(task).toBeTruthy();
  await page.getByRole('button', { name: task.title, exact: true }).click();
}

async function sourceTask(page, electronApp, text, project = true) {
  if (project) await startTaskInWorkspace(page, electronApp, text);
  else await send(page, text);
  await expect.poll(async () => (await startup(page)).tasks.length).toBe(1);
  const task = (await startup(page)).tasks[0];
  await completed(page, task.id, 1);
  return task;
}

async function extractionTask(page, sourceId) {
  await expect
    .poll(async () => (await startup(page)).tasks.find((task) => task.id !== sourceId)?.id, {
      timeout: 180_000,
    })
    .toBeTruthy();
  const task = (await startup(page)).tasks.find((task) => task.id !== sourceId);
  await completed(page, task.id, 1);
  const draft = await draftOf(page, task.id);
  expect(draft.revision).toBeGreaterThan(0);
  expect(draft.content.instructions.length).toBeGreaterThan(100);
  expect(draft.content.sources.length).toBeGreaterThan(0);
  for (const rule of draft.content.sources)
    expect(draft.source.evidence.some((item) => item.id === rule.evidenceId)).toBe(true);
  const h = await history(page, task.id);
  expect(calls(h, 'get_skill_draft').some((item) => item.status === 'completed')).toBe(true);
  expect(calls(h, 'publish_skill_draft').some((item) => item.status === 'completed')).toBe(true);
  return { task, draft };
}

async function menuExtraction(page, sourceId, focus) {
  await page.getByRole('button', { name: '任务更多操作' }).click();
  await page.getByRole('menuitem', { name: '提炼为技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从本任务提炼技能' });
  await dialog.getByLabel('提炼重点（可选）').fill(focus);
  await dialog.getByRole('button', { name: '开始提炼', exact: true }).click();
  return extractionTask(page, sourceId);
}

async function save(page, task) {
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect
    .poll(async () => {
      const audit = page.getByRole('dialog').filter({ hasText: /我已了解|输入技能名/ });
      if (await audit.count()) {
        const checkbox = audit.getByRole('checkbox', { name: '我已了解' });
        if (await checkbox.count()) await checkbox.check();
        else {
          const draft = await draftOf(page, task.id);
          await audit.getByRole('textbox').fill(draft.content.slug);
        }
        await audit.getByRole('button', { name: '保存并启用', exact: true }).click();
      }
      const draft = await draftOf(page, task.id);
      return { state: draft.state, error: draft.error };
    })
    .toEqual({ state: 'saved', error: null });
  await expect(page.locator('.ew-skill-savebar')).toContainText('已保存并启用');
  const draft = await draftOf(page, task.id);
  expect(draft.installed.revision).toBe(draft.revision);
  expect(readFileSync(join(draft.installed.path, 'SKILL.md'), 'utf8')).toContain(
    draft.content.instructions.trim(),
  );
  return draft;
}

async function record(page, electronApp, info, strict = true) {
  const model = selectRealModel();
  const home = await electronApp.evaluate(() => globalThis.__evoworkE2E.home);
  const filename = join(home, 'follow-up-wire.jsonl');
  const wire = () =>
    existsSync(filename)
      ? readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  if (strict) {
    await expect
      .poll(
        () => {
          const rows = wire();
          return rows.filter(
            (row) =>
              row.type === 'request' &&
              !rows.some(
                (outcome) =>
                  outcome.type !== 'request' && outcome.pid === row.pid && outcome.id === row.id,
              ),
          ).length;
        },
        { timeout: 60000 },
      )
      .toBe(0);
    const rows = wire();
    const requests = rows.filter((row) => row.type === 'request');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((row) => row.model === model.upstreamModel)).toBe(true);
    expect(requests.every((row) => row.endpoint === model.baseUrl + '/chat/completions')).toBe(
      true,
    );
    expect(rows.filter((row) => row.type === 'response')).toHaveLength(requests.length);
    expect(rows.filter((row) => row.type === 'response').every((row) => row.status === 200)).toBe(
      true,
    );
    expect(rows.filter((row) => row.type === 'transport-error')).toEqual([]);
  }
  const tasks = (await startup(page)).tasks;
  const snapshots = [];
  for (const task of tasks) {
    const draft = await draftOf(page, task.id);
    snapshots.push({
      task,
      history: await history(page, task.id),
      draft,
      installedMarkdown: draft?.installed
        ? readFileSync(join(draft.installed.path, 'SKILL.md'), 'utf8')
        : null,
    });
  }
  const body = JSON.stringify(
    { model: model.upstreamModel, baseUrl: model.baseUrl, wire: wire(), snapshots },
    null,
    2,
  );
  if (process.env.EVOWORK_UI_MODEL_KEY && body.includes(process.env.EVOWORK_UI_MODEL_KEY))
    throw new Error('凭据扫描命中，拒绝保存证据');
  writeFileSync(info.outputPath('skill-extraction-real-evidence.json'), body);
  await page.screenshot({ path: info.outputPath('skill-extraction-real-final.png') });
}

test.afterEach(async ({ page, electronApp }, info) => {
  await record(page, electronApp, info, info.status === info.expectedStatus);
});

test('真实模型：项目提炼、来源追溯、对话修订、保存与新数据实际复用', async ({
  page,
  electronApp,
}, info) => {
  const root = realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
  const marker = randomBytes(5).toString('hex');
  const sourceFile = 'source-' + marker + '.json';
  const input = [
    { id: 'north', sales: randomInt(400, 700), refunds: randomInt(30, 90) },
    { id: 'south', sales: randomInt(40, 90), refunds: randomInt(100, 180) },
  ];
  writeFileSync(join(root, sourceFile), JSON.stringify(input));
  const source = await sourceTask(
    page,
    electronApp,
    `读取当前目录 ${sourceFile}，本机计算每行 net=sales-refunds，负值不得归零。写入 source-result.json，格式为 {"rows":[{"id":"原始id","net":整数}],"total":整数} 并读回核验；每行保留id作为证据。不要生成汇报。${guard}`,
  );
  expect(JSON.parse(readFileSync(join(root, 'source-result.json'), 'utf8'))).toEqual({
    rows: input.map((row) => ({ id: row.id, net: row.sales - row.refunds })),
    total: input.reduce((sum, row) => sum + row.sales - row.refunds, 0),
  });
  const { task, draft: first } = await menuExtraction(
    page,
    source.id,
    '提炼净额核算方法，保留退款扣减、负值不归零和原始id证据；输入/输出文件名与数据参数化，不固定本次数字。正文写清复用步骤，首版只生成SKILL.md，不需要资源或脚本。',
  );
  expect(first.scope).toBe('project');
  expect(first.content.instructions).toMatch(/退款|refunds/);
  expect(first.content.instructions).toMatch(/负/);
  expect(first.content.instructions).not.toContain(sourceFile);
  expect(existsSync(join(root, '.agents/skills', first.content.slug))).toBe(false);
  await page.getByRole('button', { name: '查看来源', exact: true }).first().click();
  const provenance = page.getByRole('dialog', { name: '这条规则的来源' });
  await expect(provenance).not.toBeEmpty();
  await provenance.getByRole('button', { name: '在原任务中查看', exact: true }).click();
  await expect(page.locator('[data-search-focus=true]')).toBeVisible();
  await page.getByRole('button', { name: '继续提炼', exact: true }).click();
  await send(
    page,
    '修改当前技能草稿：所有交付的JSON对象都必须额外包含顶层 "quality_gate":"checked"；它表示已按原始行独立勾稽总计。保留之前退款扣减、负值与原始id规则。不要执行分析或安装，不添加资源文件，只发布新修订。',
  );
  await completed(page, task.id, 2);
  const revised = await draftOf(page, task.id);
  expect(revised.revision).toBeGreaterThan(first.revision);
  expect(revised.content.instructions).toContain('quality_gate');
  expect(revised.content.instructions).toContain('checked');
  expect(revised.content.changes.length).toBeGreaterThan(0);
  expect(revised.content.sources.some((rule) => rule.evidenceId.startsWith('edit-'))).toBe(true);
  await page.reload();
  await reopen(page, task.id);
  await expect(page.locator('.ew-skill-content')).toContainText('quality_gate');
  const saved = await save(page, task);
  await page.screenshot({ path: info.outputPath('project-saved.png') });
  const replacement = [
    { id: 'east-new', sales: randomInt(800, 1200), refunds: randomInt(10, 70) },
    { id: 'west-new', sales: 20, refunds: randomInt(40, 120) },
  ];
  writeFileSync(join(root, 'reuse-input.json'), JSON.stringify(replacement));
  await page.getByRole('button', { name: '用此技能新建任务', exact: true }).click();
  const inputBox = page.getByLabel('需求输入');
  await expect(inputBox).toHaveValue(new RegExp(saved.content.slug));
  expect((await startup(page)).tasks).toHaveLength(2);
  const prepared = await inputBox.inputValue();
  await send(
    page,
    prepared +
      '\n请按此技能处理当前目录 reuse-input.json，把结果写入 reuse-result.json 并读回核验。' +
      guard,
  );
  await expect.poll(async () => (await startup(page)).tasks.length).toBe(3);
  const reused = (await startup(page)).tasks.find(
    (item) => ![source.id, task.id].includes(item.id),
  );
  await completed(page, reused.id, 1);
  expect(realpathSync(reused.cwd)).toBe(root);
  expect(JSON.parse(readFileSync(join(root, 'reuse-result.json'), 'utf8'))).toEqual({
    rows: replacement.map((row) => ({ id: row.id, net: row.sales - row.refunds })),
    total: replacement.reduce((sum, row) => sum + row.sales - row.refunds, 0),
    quality_gate: 'checked',
  });
  writeFileSync(
    info.outputPath('reuse-check.json'),
    JSON.stringify(
      {
        input: replacement,
        actual: JSON.parse(readFileSync(join(root, 'reuse-result.json'), 'utf8')),
        expectedTotal: replacement.reduce((sum, row) => sum + row.sales - row.refunds, 0),
      },
      null,
      2,
    ),
  );
  const noProject = await page.evaluate(() => window.evowork.getComposerContext({}));
  expect(noProject.mentions.some((item) => item.name === saved.content.slug)).toBe(false);
});

test('真实模型：无项目来源默认全局，保存前不生效、保存后跨任务可发现且刷新保留', async ({
  page,
  electronApp,
}) => {
  const source = await sourceTask(
    page,
    electronApp,
    '请在回复中给一个三步数据质量检查方法：先核对必填字段和行数，再去重并保留原始记录编号，最后独立勾稽总额。遇到缺失字段先问我，不能猜测填补。不创建任何文件。' +
      guard,
    false,
  );
  expect(source.projectId).toBeNull();
  const { task, draft } = await menuExtraction(
    page,
    source.id,
    '将三步检查方法整理为可重复使用的中文技能，保留缺失字段先澄清和原始编号证据。输入字段与数据文件参数化。仅SKILL.md，不添加脚本或资源。',
  );
  expect(draft.scope).toBe('global');
  await expect(page.getByRole('radio', { name: '当前项目', exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: '所有任务', exact: true })).toBeChecked();
  expect(
    (await page.evaluate(() => window.evowork.getComposerContext({}))).mentions.some(
      (item) => item.name === draft.content.slug,
    ),
  ).toBe(false);
  const saved = await save(page, task);
  const all = await page.evaluate(() => window.evowork.getComposerContext({}));
  expect(all.mentions.find((item) => item.name === saved.content.slug)?.scope).toBe('user');
  await page.reload();
  await reopen(page, task.id);
  await expect(page.locator('.ew-skill-savebar')).toContainText('本机所有任务');
  expect((await draftOf(page, task.id)).installed).toEqual(saved.installed);
  await page.getByRole('button', { name: '查看原任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续提炼', exact: true })).toBeVisible();
});

test('真实模型：明确自然语言请求自主调用工具创建关联草稿，未保存不安装', async ({
  page,
  electronApp,
}) => {
  const source = await sourceTask(
    page,
    electronApp,
    '请确认之后做月度销售复盘时，退款按实际发生月份冲减，每个异常结论必须附原始记录编号，日期和阈值每次由我提供。只回复确认，不创建文件。' +
      guard,
  );
  await send(
    page,
    '请把本任务提炼为可复用技能，保留退款口径和证据要求，月份及阈值参数化。创建关联草稿供我审阅，不要直接安装，也不要写正式技能目录。',
  );
  await completed(page, source.id, 2);
  const sourceHistory = await history(page, source.id);
  expect(
    calls(sourceHistory, 'begin_skill_extraction').some((item) => item.status === 'completed'),
  ).toBe(true);
  expect(calls(sourceHistory, 'get_skill_draft')).toEqual([]);
  expect(calls(sourceHistory, 'publish_skill_draft')).toEqual([]);
  const lastSourceTurn = sourceHistory.turns.at(-1).id;
  const reply = sourceHistory.items
    .filter((item) => item.type === 'agentMessage' && item._turnId === lastSourceTurn)
    .map((item) => item.text)
    .join('\n');
  expect(reply).not.toMatch(/尚未生成成功|没有这个提炼任务|草稿.{0,12}生成失败/);
  await page.getByRole('button', { name: '继续提炼', exact: true }).click();
  const { task, draft } = await extractionTask(page, source.id);
  expect(draft.source.threadId).toBe(source.id);
  expect(draft.source.turns).toHaveLength(1);
  expect(draft.content.instructions).toMatch(/退款/);
  expect(draft.content.instructions).toMatch(/记录|编号|证据/);
  expect(draft.state).toBe('draft');
  expect(draft.installed).toBeNull();
  expect(existsSync(join(source.cwd, '.agents/skills', draft.content.slug))).toBe(false);
  await expect(page.locator('.ew-skill-savebar')).toContainText('草稿已自动保留，尚未成为技能');
  expect((await startup(page)).tasks).toHaveLength(2);
  expect(calls(await history(page, task.id), 'publish_skill_draft').length).toBeGreaterThan(0);
  expect(calls(await history(page, task.id), 'begin_skill_extraction')).toEqual([]);
});
