# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: skill-extraction.spec.mjs >> 无项目任务默认全局，未保存不被发现，保存后独立任务可发现并保留来源关系
- Location: apps/desktop/test/e2e/ui/skill-extraction.spec.mjs:156:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('dialog', { name: '从本任务提炼技能' })
Expected: visible
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('dialog', { name: '从本任务提炼技能' }) with timeout 20000ms
  - waiting for getByRole('dialog', { name: '从本任务提炼技能' })

```

```yaml
- navigation "侧边栏":
  - button "折叠侧边栏"
  - text: EvoWork
  - button "打开搜索框"
  - button "筛选任务"
  - button "新建任务"
  - button "自动化"
  - button "插件"
  - button "资料库"
  - region "项目":
    - button "项目" [expanded]
    - button "项目更多操作"
    - button "创建项目"
    - button "UI"
  - region "最近":
    - button "最近" [expanded]
    - list:
      - listitem:
        - button "SKILLGLOBAL-mvnc7k9d 退款按…"
        - button "SKILLGLOBAL-mvnc7k9d 退款按… 的更多操作": ⋯
  - button "wangli 菜单": wangli v44.2.0
- banner:
  - heading "SKILLGLOBAL-mvnc7k9d 退款按…" [level=1]
  - button "任务更多操作"
- alert: "Error invoking remote method 'evowork:getSkillSource': Error: 需要至少一轮完整记录；当前在途回合不会纳入。"
- main "对话区":
  - feed:
    - paragraph: SKILLGLOBAL-mvnc7k9d 退款按实际发生月份冲减，每个结论附数据证据。
    - text: 已处理 0 秒
    - paragraph: E2E response 1
    - button "策略注入 · stop:4:/private/var/folders/b6/5bqgjcl54zd0_701jf9z8bl00000gn/T/evowork-ui-a61ALC/.evowork/kernel/hooks.json"
    - paragraph: E2E response 3
  - region "输入区":
    - combobox "需求输入"
    - button "添加内容"
    - button "审批档": 请求批准
    - button "选择项目": 不使用项目
    - button "选择模型": private/e2e-model
    - button "发送" [disabled]
```

# Test source

```ts
  1   | import { existsSync, readFileSync } from 'node:fs';
  2   | import { join } from 'node:path';
  3   | import { expect, test, startTaskInWorkspace } from './fixtures.mjs';
  4   | import { horizontalOverflow, resizeWindow } from './assertions.mjs';
  5   | 
  6   | test.use({ registerModels: true });
  7   | const content = {
  8   |   slug: 'sales-evidence-review',
  9   |   name: '销售异常复盘',
  10  |   description: '按确认口径分析销售数据，输出有证据的异常清单。',
  11  |   instructions:
  12  |     '## 适用场景\n区域销售复盘。\n## 每次需要的信息\n数据文件、分析月份、区域范围和异常阈值。\n## 处理方法\n退款按实际发生月份冲减；每个结论附数据证据。\n## 交付要求\n按结论、异常区域、证据、下一步组织报告。',
  13  |   changes: ['保留统计口径，月份与数据文件参数化。'],
  14  |   sources: [{ rule: '统计口径与证据要求', evidenceId: 'source-0' }],
  15  |   files: [],
  16  | };
  17  | async function scriptExtraction(electronApp, marker, value = content, revision = 0) {
  18  |   await electronApp.evaluate(
  19  |     (_electron, { marker, value, revision }) => {
  20  |       const gateway = globalThis.__evoworkE2E.gateway;
  21  |       const extraction = (view) =>
  22  |         view.text.includes(marker) && view.text.includes('先调用 skill_drafts.get_skill_draft');
  23  |       gateway.scriptWhen(
  24  |         'skill-get-' + revision,
  25  |         (view) => extraction(view) && !view.calls.includes('get_skill_draft'),
  26  |         { tool: 'get_skill_draft', args: {} },
  27  |       );
  28  |       gateway.scriptWhen(
  29  |         'skill-publish-' + revision,
  30  |         (view) =>
  31  |           extraction(view) &&
  32  |           view.calls.includes('get_skill_draft') &&
  33  |           !view.calls.includes('publish_skill_draft'),
  34  |         { tool: 'publish_skill_draft', args: { expectedRevision: revision, draft: value } },
  35  |       );
  36  |       gateway.scriptWhen(
  37  |         'skill-next-' + revision,
  38  |         (view) =>
  39  |           extraction(view) &&
  40  |           view.calls.includes('publish_skill_draft') &&
  41  |           !view.calls.includes('propose_next_actions'),
  42  |         { tool: 'propose_next_actions', args: { outcome: 'delivered', actions: [] } },
  43  |       );
  44  |       gateway.scriptWhen(
  45  |         'skill-finish-' + revision,
  46  |         (view) =>
  47  |           extraction(view) &&
  48  |           view.calls.includes('publish_skill_draft') &&
  49  |           view.calls.includes('propose_next_actions'),
  50  |         { kind: 'text', text: '技能草稿已发布，等待审阅。' },
  51  |       );
  52  |     },
  53  |     { marker, value, revision },
  54  |   );
  55  | }
  56  | async function idle(page) {
  57  |   await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
  58  |     timeout: 60000,
  59  |   });
  60  | }
  61  | async function extract(page, focus = '') {
  62  |   await page.getByRole('button', { name: '任务更多操作' }).click();
  63  |   await page.getByRole('menuitem', { name: '提炼为技能', exact: true }).click();
  64  |   const dialog = page.getByRole('dialog', { name: '从本任务提炼技能' });
> 65  |   await expect(dialog).toBeVisible();
      |                        ^ Error: expect(locator).toBeVisible() failed
  66  |   if (focus) await dialog.getByLabel('提炼重点（可选）').fill(focus);
  67  |   await dialog.getByRole('button', { name: '开始提炼', exact: true }).click();
  68  |   await expect(page.locator('.ew-skill-panel-head')).toContainText(content.name);
  69  |   await idle(page);
  70  | }
  71  | 
  72  | test('项目任务从菜单提炼、来源定位、模型修改、刷新恢复、保存并复用，项目技能不出现在无项目任务', async ({
  73  |   page,
  74  |   electronApp,
  75  | }, testInfo) => {
  76  |   const marker = 'SKILLEXTRACT-' + Date.now().toString(36);
  77  |   await startTaskInWorkspace(
  78  |     page,
  79  |     electronApp,
  80  |     marker + ' 退款按实际发生月份冲减，每个结论附数据证据。',
  81  |   );
  82  |   await idle(page);
  83  |   const source = (await page.evaluate(() => window.evowork.getStartup())).tasks[0];
  84  |   await scriptExtraction(electronApp, marker);
  85  |   await extract(page, '保留统计口径和报告结构，月份与文件参数化。');
  86  |   const extraction = (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
  87  |     (task) => task.id !== source.id,
  88  |   );
  89  |   expect(extraction).toBeTruthy();
  90  |   let draft = await page.evaluate(
  91  |     (threadId) => window.evowork.getSkillExtraction({ threadId }),
  92  |     extraction.id,
  93  |   );
  94  |   expect(draft.revision).toBe(1);
  95  |   expect(draft.scope).toBe('project');
  96  |   expect(existsSync(join(source.cwd, '.agents/skills', content.slug))).toBe(false);
  97  |   await page.getByRole('button', { name: '查看来源', exact: true }).click();
  98  |   await expect(page.getByRole('dialog', { name: '这条规则的来源' })).toContainText(
  99  |     '退款按实际发生月份冲减',
  100 |   );
  101 |   await page.getByRole('button', { name: '在原任务中查看', exact: true }).click();
  102 |   await expect(page.locator('[data-search-focus=true]')).toContainText('退款按实际发生月份冲减');
  103 |   await page.getByRole('button', { name: '继续提炼', exact: true }).click();
  104 |   await expect(page.locator('.ew-skill-panel-head')).toContainText(content.name);
  105 |   const changed = {
  106 |     ...content,
  107 |     instructions:
  108 |       '## 每次需要的信息\n数据与月份。\n## 处理方法\n退款按实际发生月份冲减。\n## 交付要求\n仅输出异常清单与对应数据证据。',
  109 |     changes: ['移除报告生成，保留异常清单与证据。'],
  110 |   };
  111 |   await electronApp.evaluate((_electron, changed) => {
  112 |     const gateway = globalThis.__evoworkE2E.gateway;
  113 |     gateway.scriptWhen(
  114 |       'skill-edit-publish',
  115 |       (view) => view.text.includes('只保留分析方法，去掉报告生成要求'),
  116 |       { tool: 'publish_skill_draft', args: { expectedRevision: 1, draft: changed } },
  117 |     );
  118 |     gateway.scriptWhen(
  119 |       'skill-edit-finish',
  120 |       (view) => view.text.includes('只保留分析方法，去掉报告生成要求'),
  121 |       { kind: 'text', text: '已移除报告要求。' },
  122 |     );
  123 |   }, changed);
  124 |   await page.getByRole('button', { name: '只保留分析方法', exact: true }).click();
  125 |   await expect(page.locator('.ew-skill-changes')).toContainText('移除报告生成');
  126 |   await idle(page);
  127 |   await page.locator('.ew-skill-filebar select').selectOption('SKILL.md');
  128 |   await expect(page.locator('.ew-skill-code')).toContainText('仅输出异常清单');
  129 |   await page.reload();
  130 |   await page.getByRole('button', { name: extraction.title, exact: true }).click();
  131 |   await expect(page.locator('.ew-skill-panel-head')).toContainText(content.name);
  132 |   await expect(page.locator('.ew-skill-content')).toContainText('仅输出异常清单');
  133 |   await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  134 |   await expect(page.locator('.ew-skill-savebar')).toContainText('已保存并启用');
  135 |   draft = await page.evaluate(
  136 |     (threadId) => window.evowork.getSkillExtraction({ threadId }),
  137 |     extraction.id,
  138 |   );
  139 |   expect(draft.installed.revision).toBe(2);
  140 |   expect(
  141 |     readFileSync(join(source.cwd, '.agents/skills', content.slug, 'SKILL.md'), 'utf8'),
  142 |   ).toContain('仅输出异常清单');
  143 |   await page.screenshot({ path: testInfo.outputPath('skill-extraction-saved.png') });
  144 |   await resizeWindow(electronApp, 480, 820);
  145 |   if (await page.getByRole('button', { name: '打开结果', exact: true }).isVisible())
  146 |     await page.getByRole('button', { name: '打开结果', exact: true }).click();
  147 |   expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  148 |   await page.screenshot({ path: testInfo.outputPath('skill-extraction-480.png') });
  149 |   await page.getByRole('button', { name: '用此技能新建任务', exact: true }).click();
  150 |   await expect(page.getByLabel('需求输入')).toHaveValue(new RegExp(content.slug));
  151 |   expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(2);
  152 |   const noProject = await page.evaluate(async () => window.evowork.getComposerContext({}));
  153 |   expect(noProject.mentions.some((skill) => skill.name === content.slug)).toBe(false);
  154 | });
  155 | 
  156 | test('无项目任务默认全局，未保存不被发现，保存后独立任务可发现并保留来源关系', async ({
  157 |   page,
  158 |   electronApp,
  159 | }) => {
  160 |   const marker = 'SKILLGLOBAL-' + Date.now().toString(36);
  161 |   await page.getByLabel('需求输入').fill(marker + ' 退款按实际发生月份冲减，每个结论附数据证据。');
  162 |   await page.getByRole('button', { name: '发送', exact: true }).click();
  163 |   await expect
  164 |     .poll(async () => (await page.evaluate(() => window.evowork.getStartup())).tasks.length)
  165 |     .toBe(1);
```