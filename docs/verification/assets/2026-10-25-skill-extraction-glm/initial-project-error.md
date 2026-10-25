# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: skill-extraction.real.spec.mjs >> 真实模型：项目提炼、来源追溯、对话修订、保存与新数据实际复用
- Location: apps/desktop/test/e2e/ui/skill-extraction.real.spec.mjs:183:1

# Error details

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: '从“读取当前目录 source-a6665fac…', exact: true })

```

# Page snapshot

```yaml
- generic [ref=f2e3]:
  - navigation "侧边栏" [ref=f2e4]:
    - button "折叠侧边栏" [ref=f2e6] [cursor=pointer]
    - generic [ref=f2e9]:
      - generic [ref=f2e10]: EvoWork
      - button "打开搜索框" [ref=f2e15] [cursor=pointer]
      - button "筛选任务" [ref=f2e20] [cursor=pointer]
    - button "新建任务" [ref=f2e24] [cursor=pointer]
    - generic [ref=f2e29]:
      - generic [ref=f2e30]:
        - button "自动化" [ref=f2e31] [cursor=pointer]
        - button "插件" [ref=f2e37] [cursor=pointer]
        - button "资料库" [ref=f2e44] [cursor=pointer]
      - region "项目" [ref=f2e49]:
        - generic [ref=f2e50]:
          - button "项目" [expanded] [ref=f2e51] [cursor=pointer]
          - generic [ref=f2e56]:
            - generic:
              - generic:
                - button "项目更多操作":
                  - generic [aria-hidden]: ⋯
              - button "创建项目"
        - button "UI" [ref=f2e60] [cursor=pointer]
      - region "最近" [ref=f2e68]:
        - button "最近" [expanded] [ref=f2e70] [cursor=pointer]
        - list [ref=f2e77]:
          - listitem [ref=f2e78]:
            - generic [ref=f2e80]:
              - button "提炼技能 · 读取当前目录 source-a6665facb7…" [ref=f2e81] [cursor=pointer]
              - button "提炼技能 · 读取当前目录 source-a6665facb7… 的更多操作" [ref=f2e83] [cursor=pointer]: ⋯
          - listitem [ref=f2e84]:
            - generic [ref=f2e86]:
              - button "读取当前目录 source-a6665facb7…" [ref=f2e87] [cursor=pointer]
              - button "读取当前目录 source-a6665facb7… 的更多操作" [ref=f2e89] [cursor=pointer]: ⋯
    - button "wangli 菜单" [ref=f2e93] [cursor=pointer]:
      - generic [aria-hidden] [ref=f2e94]: w
      - generic [ref=f2e95]:
        - generic [ref=f2e96]: wangli
        - generic [ref=f2e97]: v44.2.0
  - generic [ref=f2e101]:
    - heading "有什么可以帮忙的？" [level=1] [ref=f2e102]
    - group "快捷建议" [ref=f2e103]:
      - generic [ref=f2e104]:
        - button "文档处理" [ref=f2e105] [cursor=pointer]
        - button "金融服务" [ref=f2e111] [cursor=pointer]
        - button "数据分析及可视化" [ref=f2e116] [cursor=pointer]
        - button "个人工作台" [ref=f2e122] [cursor=pointer]
    - region "输入区" [ref=f2e130]:
      - generic [ref=f2e132]:
        - combobox "需求输入" [ref=f2e133]
        - generic [ref=f2e134]:
          - button "添加内容" [ref=f2e136] [cursor=pointer]
          - button "审批档" [ref=f2e139] [cursor=pointer]:
            - generic [ref=f2e143]: 请求批准
            - generic [aria-hidden] [ref=f2e144]: ▾
          - button "选择项目" [ref=f2e146] [cursor=pointer]:
            - generic [ref=f2e150]: 不使用项目
            - generic [aria-hidden] [ref=f2e151]: ▾
          - button "选择模型" [ref=f2e153] [cursor=pointer]:
            - generic [ref=f2e154]: zhipu/glm-5.3-flash
            - generic [aria-hidden] [ref=f2e155]: ▾
          - button "发送" [disabled] [ref=f2e156]
```

# Test source

```ts
  132 |       .poll(
  133 |         () => {
  134 |           const rows = wire();
  135 |           return rows.filter(
  136 |             (row) =>
  137 |               row.type === 'request' &&
  138 |               !rows.some(
  139 |                 (outcome) =>
  140 |                   outcome.type !== 'request' && outcome.pid === row.pid && outcome.id === row.id,
  141 |               ),
  142 |           ).length;
  143 |         },
  144 |         { timeout: 60000 },
  145 |       )
  146 |       .toBe(0);
  147 |     const rows = wire();
  148 |     const requests = rows.filter((row) => row.type === 'request');
  149 |     expect(requests.length).toBeGreaterThan(0);
  150 |     expect(requests.every((row) => row.model === model.upstreamModel)).toBe(true);
  151 |     expect(requests.every((row) => row.endpoint === model.baseUrl + '/chat/completions')).toBe(
  152 |       true,
  153 |     );
  154 |     expect(rows.filter((row) => row.type === 'response')).toHaveLength(requests.length);
  155 |     expect(rows.filter((row) => row.type === 'response').every((row) => row.status === 200)).toBe(
  156 |       true,
  157 |     );
  158 |     expect(rows.filter((row) => row.type === 'transport-error')).toEqual([]);
  159 |   }
  160 |   const tasks = (await startup(page)).tasks;
  161 |   const snapshots = [];
  162 |   for (const task of tasks)
  163 |     snapshots.push({
  164 |       task,
  165 |       history: await history(page, task.id),
  166 |       draft: await draftOf(page, task.id),
  167 |     });
  168 |   const body = JSON.stringify(
  169 |     { model: model.upstreamModel, baseUrl: model.baseUrl, wire: wire(), snapshots },
  170 |     null,
  171 |     2,
  172 |   );
  173 |   if (process.env.EVOWORK_UI_MODEL_KEY && body.includes(process.env.EVOWORK_UI_MODEL_KEY))
  174 |     throw new Error('凭据扫描命中，拒绝保存证据');
  175 |   writeFileSync(info.outputPath('skill-extraction-real-evidence.json'), body);
  176 |   await page.screenshot({ path: info.outputPath('skill-extraction-real-final.png') });
  177 | }
  178 | 
  179 | test.afterEach(async ({ page, electronApp }, info) => {
  180 |   await record(page, electronApp, info, info.status === info.expectedStatus);
  181 | });
  182 | 
  183 | test('真实模型：项目提炼、来源追溯、对话修订、保存与新数据实际复用', async ({
  184 |   page,
  185 |   electronApp,
  186 | }, info) => {
  187 |   const root = realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
  188 |   const marker = randomBytes(5).toString('hex');
  189 |   const sourceFile = 'source-' + marker + '.json';
  190 |   const input = [
  191 |     { id: 'north', sales: randomInt(400, 700), refunds: randomInt(30, 90) },
  192 |     { id: 'south', sales: randomInt(40, 90), refunds: randomInt(100, 180) },
  193 |   ];
  194 |   writeFileSync(join(root, sourceFile), JSON.stringify(input));
  195 |   const source = await sourceTask(
  196 |     page,
  197 |     electronApp,
  198 |     `读取当前目录 ${sourceFile}，本机计算每行 net=sales-refunds，负值不得归零。写入 source-result.json，格式为 {"rows":[{"id":"原始id","net":整数}],"total":整数} 并读回核验；每行保留id作为证据。不要生成汇报。${guard}`,
  199 |   );
  200 |   expect(JSON.parse(readFileSync(join(root, 'source-result.json'), 'utf8'))).toEqual({
  201 |     rows: input.map((row) => ({ id: row.id, net: row.sales - row.refunds })),
  202 |     total: input.reduce((sum, row) => sum + row.sales - row.refunds, 0),
  203 |   });
  204 |   const { task, draft: first } = await menuExtraction(
  205 |     page,
  206 |     source.id,
  207 |     '提炼净额核算方法，保留退款扣减、负值不归零和原始id证据；输入/输出文件名与数据参数化，不固定本次数字。正文写清复用步骤，首版只生成SKILL.md，不需要资源或脚本。',
  208 |   );
  209 |   expect(first.scope).toBe('project');
  210 |   expect(first.content.instructions).toMatch(/退款|refunds/);
  211 |   expect(first.content.instructions).toMatch(/负/);
  212 |   expect(first.content.instructions).not.toContain(sourceFile);
  213 |   expect(existsSync(join(root, '.agents/skills', first.content.slug))).toBe(false);
  214 |   await page.getByRole('button', { name: '查看来源', exact: true }).first().click();
  215 |   const provenance = page.getByRole('dialog', { name: '这条规则的来源' });
  216 |   await expect(provenance).not.toBeEmpty();
  217 |   await provenance.getByRole('button', { name: '在原任务中查看', exact: true }).click();
  218 |   await expect(page.locator('[data-search-focus=true]')).toBeVisible();
  219 |   await page.getByRole('button', { name: '继续提炼', exact: true }).click();
  220 |   await send(
  221 |     page,
  222 |     '修改当前技能草稿：所有交付的JSON对象都必须额外包含顶层 "quality_gate":"checked"；它表示已按原始行独立勾稽总计。保留之前退款扣减、负值与原始id规则。不要执行分析或安装，不添加资源文件，只发布新修订。',
  223 |   );
  224 |   await completed(page, task.id, 2);
  225 |   const revised = await draftOf(page, task.id);
  226 |   expect(revised.revision).toBeGreaterThan(first.revision);
  227 |   expect(revised.content.instructions).toContain('quality_gate');
  228 |   expect(revised.content.instructions).toContain('checked');
  229 |   expect(revised.content.changes.length).toBeGreaterThan(0);
  230 |   expect(revised.content.sources.some((rule) => rule.evidenceId.startsWith('edit-'))).toBe(true);
  231 |   await page.reload();
> 232 |   await page.getByRole('button', { name: task.title, exact: true }).click();
      |                                                                     ^ TimeoutError: locator.click: Timeout 30000ms exceeded.
  233 |   await expect(page.locator('.ew-skill-content')).toContainText('quality_gate');
  234 |   const saved = await save(page, task);
  235 |   await page.screenshot({ path: info.outputPath('project-saved.png') });
  236 |   const replacement = [
  237 |     { id: 'east-new', sales: randomInt(800, 1200), refunds: randomInt(10, 70) },
  238 |     { id: 'west-new', sales: 20, refunds: randomInt(40, 120) },
  239 |   ];
  240 |   writeFileSync(join(root, 'reuse-input.json'), JSON.stringify(replacement));
  241 |   await page.getByRole('button', { name: '用此技能新建任务', exact: true }).click();
  242 |   const inputBox = page.getByLabel('需求输入');
  243 |   await expect(inputBox).toHaveValue(new RegExp(saved.content.slug));
  244 |   expect((await startup(page)).tasks).toHaveLength(2);
  245 |   const prepared = await inputBox.inputValue();
  246 |   await send(
  247 |     page,
  248 |     prepared +
  249 |       '\n请按此技能处理当前目录 reuse-input.json，把结果写入 reuse-result.json 并读回核验。' +
  250 |       guard,
  251 |   );
  252 |   await expect.poll(async () => (await startup(page)).tasks.length).toBe(3);
  253 |   const reused = (await startup(page)).tasks.find(
  254 |     (item) => ![source.id, task.id].includes(item.id),
  255 |   );
  256 |   await completed(page, reused.id, 1);
  257 |   expect(realpathSync(reused.cwd)).toBe(root);
  258 |   expect(JSON.parse(readFileSync(join(root, 'reuse-result.json'), 'utf8'))).toEqual({
  259 |     rows: replacement.map((row) => ({ id: row.id, net: row.sales - row.refunds })),
  260 |     total: replacement.reduce((sum, row) => sum + row.sales - row.refunds, 0),
  261 |     quality_gate: 'checked',
  262 |   });
  263 |   const noProject = await page.evaluate(() => window.evowork.getComposerContext({}));
  264 |   expect(noProject.mentions.some((item) => item.name === saved.content.slug)).toBe(false);
  265 | });
  266 | 
  267 | test('真实模型：无项目来源默认全局，保存前不生效、保存后跨任务可发现且刷新保留', async ({
  268 |   page,
  269 |   electronApp,
  270 | }) => {
  271 |   const source = await sourceTask(
  272 |     page,
  273 |     electronApp,
  274 |     '请在回复中给一个三步数据质量检查方法：先核对必填字段和行数，再去重并保留原始记录编号，最后独立勾稽总额。遇到缺失字段先问我，不能猜测填补。不创建任何文件。' +
  275 |       guard,
  276 |     false,
  277 |   );
  278 |   expect(source.projectId).toBeNull();
  279 |   const { task, draft } = await menuExtraction(
  280 |     page,
  281 |     source.id,
  282 |     '将三步检查方法整理为可重复使用的中文技能，保留缺失字段先澄清和原始编号证据。输入字段与数据文件参数化。仅SKILL.md，不添加脚本或资源。',
  283 |   );
  284 |   expect(draft.scope).toBe('global');
  285 |   await expect(page.getByRole('radio', { name: '当前项目', exact: true })).toBeDisabled();
  286 |   await expect(page.getByRole('radio', { name: '所有任务', exact: true })).toBeChecked();
  287 |   expect(
  288 |     (await page.evaluate(() => window.evowork.getComposerContext({}))).mentions.some(
  289 |       (item) => item.name === draft.content.slug,
  290 |     ),
  291 |   ).toBe(false);
  292 |   const saved = await save(page, task);
  293 |   const all = await page.evaluate(() => window.evowork.getComposerContext({}));
  294 |   expect(all.mentions.find((item) => item.name === saved.content.slug)?.scope).toBe('user');
  295 |   await page.reload();
  296 |   await page.getByRole('button', { name: task.title, exact: true }).click();
  297 |   await expect(page.locator('.ew-skill-savebar')).toContainText('本机所有任务');
  298 |   expect((await draftOf(page, task.id)).installed).toEqual(saved.installed);
  299 |   await page.getByRole('button', { name: '查看原任务', exact: true }).click();
  300 |   await expect(page.getByRole('button', { name: '继续提炼', exact: true })).toBeVisible();
  301 | });
  302 | 
  303 | test('真实模型：明确自然语言请求自主调用工具创建关联草稿，未保存不安装', async ({
  304 |   page,
  305 |   electronApp,
  306 | }) => {
  307 |   const source = await sourceTask(
  308 |     page,
  309 |     electronApp,
  310 |     '请确认之后做月度销售复盘时，退款按实际发生月份冲减，每个异常结论必须附原始记录编号，日期和阈值每次由我提供。只回复确认，不创建文件。' +
  311 |       guard,
  312 |   );
  313 |   await send(
  314 |     page,
  315 |     '请把本任务提炼为可复用技能，保留退款口径和证据要求，月份及阈值参数化。创建关联草稿供我审阅，不要直接安装，也不要写正式技能目录。',
  316 |   );
  317 |   await completed(page, source.id, 2);
  318 |   const sourceHistory = await history(page, source.id);
  319 |   expect(
  320 |     calls(sourceHistory, 'begin_skill_extraction').some((item) => item.status === 'completed'),
  321 |   ).toBe(true);
  322 |   await page.getByRole('button', { name: '继续提炼', exact: true }).click();
  323 |   const { task, draft } = await extractionTask(page, source.id);
  324 |   expect(draft.source.threadId).toBe(source.id);
  325 |   expect(draft.source.turns).toHaveLength(1);
  326 |   expect(draft.content.instructions).toMatch(/退款/);
  327 |   expect(draft.content.instructions).toMatch(/记录|编号|证据/);
  328 |   expect(draft.state).toBe('draft');
  329 |   expect(draft.installed).toBeNull();
  330 |   expect(existsSync(join(source.cwd, '.agents/skills', draft.content.slug))).toBe(false);
  331 |   await expect(page.locator('.ew-skill-savebar')).toContainText('草稿已自动保留，尚未成为技能');
  332 |   expect((await startup(page)).tasks).toHaveLength(2);
```