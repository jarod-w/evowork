import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, startTaskInWorkspace } from './fixtures.mjs';
import { horizontalOverflow, resizeWindow } from './assertions.mjs';

test.use({ registerModels: true });
const content = {
  slug: 'sales-evidence-review',
  name: '销售异常复盘',
  description: '按确认口径分析销售数据，输出有证据的异常清单。',
  instructions:
    '## 适用场景\n区域销售复盘。\n## 每次需要的信息\n数据文件、分析月份、区域范围和异常阈值。\n## 处理方法\n退款按实际发生月份冲减；每个结论附数据证据。\n## 交付要求\n按结论、异常区域、证据、下一步组织报告。',
  changes: ['保留统计口径，月份与数据文件参数化。'],
  sources: [{ rule: '统计口径与证据要求', evidenceId: 'source-0' }],
  files: [],
};
async function scriptExtraction(electronApp, marker, value = content, revision = 0) {
  await electronApp.evaluate(
    (_electron, { marker, value, revision }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      const extraction = (view) =>
        view.text.includes(marker) && view.text.includes('先调用 skill_drafts.get_skill_draft');
      gateway.scriptWhen(
        'skill-get-' + revision,
        (view) => extraction(view) && !view.calls.includes('get_skill_draft'),
        { tool: 'get_skill_draft', args: {} },
      );
      gateway.scriptWhen(
        'skill-publish-' + revision,
        (view) =>
          extraction(view) &&
          view.calls.includes('get_skill_draft') &&
          !view.calls.includes('publish_skill_draft'),
        { tool: 'publish_skill_draft', args: { expectedRevision: revision, draft: value } },
      );
      gateway.scriptWhen(
        'skill-next-' + revision,
        (view) =>
          extraction(view) &&
          view.calls.includes('publish_skill_draft') &&
          !view.calls.includes('propose_next_actions'),
        { tool: 'propose_next_actions', args: { outcome: 'delivered', actions: [] } },
      );
      gateway.scriptWhen(
        'skill-finish-' + revision,
        (view) =>
          extraction(view) &&
          view.calls.includes('publish_skill_draft') &&
          view.calls.includes('propose_next_actions'),
        { kind: 'text', text: '技能草稿已发布，等待审阅。' },
      );
    },
    { marker, value, revision },
  );
}
async function idle(page, threadId) {
  if (threadId)
    await expect
      .poll(
        async () => {
          const history = await page.evaluate(
            (id) => window.evowork.openTask({ threadId: id }),
            threadId,
          );
          return (
            history.turns.length > 0 && history.turns.every((turn) => turn.status === 'completed')
          );
        },
        { timeout: 60000 },
      )
      .toBe(true);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 60000,
  });
}
async function extract(page, focus = '') {
  await page.getByRole('button', { name: '任务更多操作' }).click();
  await page.getByRole('menuitem', { name: '提炼为技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从本任务提炼技能' });
  await expect(dialog).toBeVisible();
  if (focus) await dialog.getByLabel('提炼重点（可选）').fill(focus);
  await dialog.getByRole('button', { name: '开始提炼', exact: true }).click();
  await expect(page.locator('.ew-skill-panel-head')).toContainText(content.name);
  await idle(page);
}

test('项目任务从菜单提炼、来源定位、模型修改、刷新恢复、保存并复用，项目技能不出现在无项目任务', async ({
  page,
  electronApp,
}, testInfo) => {
  const marker = 'SKILLEXTRACT-' + Date.now().toString(36);
  await startTaskInWorkspace(
    page,
    electronApp,
    marker + ' 退款按实际发生月份冲减，每个结论附数据证据。',
  );
  const source = (await page.evaluate(() => window.evowork.getStartup())).tasks[0];
  await idle(page, source.id);
  await scriptExtraction(electronApp, marker);
  await extract(page, '保留统计口径和报告结构，月份与文件参数化。');
  const extraction = (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
    (task) => task.id !== source.id,
  );
  expect(extraction).toBeTruthy();
  let draft = await page.evaluate(
    (threadId) => window.evowork.getSkillExtraction({ threadId }),
    extraction.id,
  );
  expect(draft.revision).toBe(1);
  expect(draft.scope).toBe('project');
  expect(existsSync(join(source.cwd, '.agents/skills', content.slug))).toBe(false);
  await page.getByRole('button', { name: '查看来源', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '这条规则的来源' })).toContainText(
    '退款按实际发生月份冲减',
  );
  await page.getByRole('button', { name: '在原任务中查看', exact: true }).click();
  await expect(page.locator('[data-search-focus=true]')).toContainText('退款按实际发生月份冲减');
  await page.getByRole('button', { name: '继续提炼', exact: true }).click();
  await expect(page.locator('.ew-skill-panel-head')).toContainText(content.name);
  const changed = {
    ...content,
    instructions:
      '## 每次需要的信息\n数据与月份。\n## 处理方法\n退款按实际发生月份冲减。\n## 交付要求\n仅输出异常清单与对应数据证据。',
    changes: ['移除报告生成，保留异常清单与证据。'],
  };
  await electronApp.evaluate((_electron, changed) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen(
      'skill-edit-publish',
      (view) => view.text.includes('只保留分析方法，去掉报告生成要求'),
      { tool: 'publish_skill_draft', args: { expectedRevision: 1, draft: changed } },
    );
    gateway.scriptWhen(
      'skill-edit-finish',
      (view) => view.text.includes('只保留分析方法，去掉报告生成要求'),
      { kind: 'text', text: '已移除报告要求。' },
    );
  }, changed);
  await page.getByRole('button', { name: '只保留分析方法', exact: true }).click();
  await expect(page.locator('.ew-skill-changes')).toContainText('移除报告生成');
  await idle(page);
  await page.locator('.ew-skill-filebar select').selectOption('SKILL.md');
  await expect(page.locator('.ew-skill-code')).toContainText('仅输出异常清单');
  await page.reload();
  await page.getByRole('button', { name: extraction.title, exact: true }).click();
  await expect(page.locator('.ew-skill-panel-head')).toContainText(content.name);
  await expect(page.locator('.ew-skill-content')).toContainText('仅输出异常清单');
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect(page.locator('.ew-skill-savebar')).toContainText('已保存并启用');
  draft = await page.evaluate(
    (threadId) => window.evowork.getSkillExtraction({ threadId }),
    extraction.id,
  );
  expect(draft.installed.revision).toBe(2);
  expect(
    readFileSync(join(source.cwd, '.agents/skills', content.slug, 'SKILL.md'), 'utf8'),
  ).toContain('仅输出异常清单');
  await page.screenshot({ path: testInfo.outputPath('skill-extraction-saved.png') });
  await resizeWindow(electronApp, 480, 820);
  if (await page.getByRole('button', { name: '打开结果', exact: true }).isVisible())
    await page.getByRole('button', { name: '打开结果', exact: true }).click();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('skill-extraction-480.png') });
  await page.getByRole('button', { name: '用此技能新建任务', exact: true }).click();
  await expect(page.getByLabel('需求输入')).toHaveValue(new RegExp(content.slug));
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(2);
  const noProject = await page.evaluate(async () => window.evowork.getComposerContext({}));
  expect(noProject.mentions.some((skill) => skill.name === content.slug)).toBe(false);
});

test('无项目任务默认全局，未保存不被发现，保存后独立任务可发现并保留来源关系', async ({
  page,
  electronApp,
}) => {
  const marker = 'SKILLGLOBAL-' + Date.now().toString(36);
  await page.getByLabel('需求输入').fill(marker + ' 退款按实际发生月份冲减，每个结论附数据证据。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getStartup())).tasks.length)
    .toBe(1);
  const source = (await page.evaluate(() => window.evowork.getStartup())).tasks[0];
  await idle(page, source.id);
  expect(source.projectId).toBeNull();
  await scriptExtraction(electronApp, marker);
  await extract(page);
  await expect(page.getByRole('radio', { name: '当前项目', exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: '所有任务', exact: true })).toBeChecked();
  expect(
    (await page.evaluate(() => window.evowork.getComposerContext({}))).mentions.some(
      (skill) => skill.name === content.slug,
    ),
  ).toBe(false);
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect(page.locator('.ew-skill-savebar')).toContainText('已保存并启用');
  const extraction = (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
    (task) => task.id !== source.id,
  );
  await page.reload();
  await page.getByRole('button', { name: extraction.title, exact: true }).click();
  await expect(page.locator('.ew-skill-savebar')).toContainText('本机所有任务');
  const available = (
    await page.evaluate(() => window.evowork.getComposerContext({}))
  ).mentions.find((skill) => skill.name === content.slug);
  expect(available.scope).toBe('user');
  await page.getByRole('button', { name: '查看原任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续提炼', exact: true })).toBeVisible();
});

test('明确的自然语言要求通过真实工具创建关联草稿，未保存不安装', async ({ page, electronApp }) => {
  const marker = 'SKILLNAT-' + Date.now().toString(36);
  await startTaskInWorkspace(
    page,
    electronApp,
    marker + ' 退款按实际发生月份冲减，结论附数据证据。',
  );
  const source = (await page.evaluate(() => window.evowork.getStartup())).tasks[0];
  await idle(page, source.id);
  await scriptExtraction(electronApp, marker);
  await electronApp.evaluate((_electron, marker) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    const root = (view) =>
      view.text.includes(marker) &&
      view.text.includes('请把本任务提炼为技能') &&
      !view.text.includes('先调用 skill_drafts.get_skill_draft');
    gateway.scriptWhen(
      'natural-skill-begin',
      (view) => root(view) && !view.calls.includes('begin_skill_extraction'),
      { tool: 'begin_skill_extraction', args: { focus: '保留统计口径，数据与月份参数化。' } },
    );
    gateway.scriptWhen(
      'natural-skill-next',
      (view) =>
        root(view) &&
        view.calls.includes('begin_skill_extraction') &&
        !view.calls.includes('propose_next_actions'),
      { tool: 'propose_next_actions', args: { outcome: 'delivered', actions: [] } },
    );
    gateway.scriptWhen(
      'natural-skill-finish',
      (view) => root(view) && view.calls.includes('begin_skill_extraction'),
      { kind: 'text', text: '已创建关联提炼任务，请打开草稿审阅。' },
    );
  }, marker);
  await page.getByLabel('需求输入').fill('请把本任务提炼为技能，保留统计口径。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '继续提炼', exact: true }).click();
  await expect(page.locator('.ew-skill-panel-head')).toContainText(content.name);
  await idle(page);
  await expect(page.locator('.ew-skill-savebar')).toContainText('草稿已自动保留，尚未成为技能');
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(2);
});
