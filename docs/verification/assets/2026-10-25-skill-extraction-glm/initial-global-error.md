# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: skill-extraction.real.spec.mjs >> 真实模型：无项目来源默认全局，保存前不生效、保存后跨任务可发现且刷新保留
- Location: apps/desktop/test/e2e/ui/skill-extraction.real.spec.mjs:267:1

# Error details

```
Error: 文件已保存，正在核对启用状态。
```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - navigation "侧边栏" [ref=f1e4]:
    - button "折叠侧边栏" [ref=f1e6] [cursor=pointer]
    - generic [ref=f1e9]:
      - generic [ref=f1e10]: EvoWork
      - button "打开搜索框" [ref=f1e15] [cursor=pointer]
      - button "筛选任务" [ref=f1e20] [cursor=pointer]
    - button "新建任务" [ref=f1e24] [cursor=pointer]
    - generic [ref=f1e29]:
      - generic [ref=f1e30]:
        - button "自动化" [ref=f1e31] [cursor=pointer]
        - button "插件" [ref=f1e37] [cursor=pointer]
        - button "资料库" [ref=f1e44] [cursor=pointer]
      - region "项目" [ref=f1e49]:
        - generic [ref=f1e50]:
          - button "项目" [expanded] [ref=f1e51] [cursor=pointer]
          - generic [ref=f1e56]:
            - generic:
              - generic:
                - button "项目更多操作":
                  - generic [aria-hidden]: ⋯
              - button "创建项目"
        - button "UI" [ref=f1e60] [cursor=pointer]
      - region "最近" [ref=f1e68]:
        - button "最近" [expanded] [ref=f1e70] [cursor=pointer]
        - list [ref=f1e77]:
          - listitem [ref=f1e78]:
            - generic [ref=f1e80]:
              - button "提炼技能 · 在回复中给一个三步数据质量检查方法：先核对必填字…" [ref=f1e81] [cursor=pointer]
              - button "提炼技能 · 在回复中给一个三步数据质量检查方法：先核对必填字… 的更多操作" [ref=f1e83] [cursor=pointer]: ⋯
          - listitem [ref=f1e84]:
            - generic [ref=f1e86]:
              - button "在回复中给一个三步数据质量检查方法：先核对必填字…" [ref=f1e87] [cursor=pointer]
              - button "在回复中给一个三步数据质量检查方法：先核对必填字… 的更多操作" [ref=f1e89] [cursor=pointer]: ⋯
    - button "wangli 菜单" [ref=f1e93] [cursor=pointer]:
      - generic [aria-hidden] [ref=f1e94]: w
      - generic [ref=f1e95]:
        - generic [ref=f1e96]: wangli
        - generic [ref=f1e97]: v44.2.0
  - generic [ref=f1e98]:
    - banner [ref=f1e99]:
      - heading "提炼技能 · 在回复中给一个三步数据质量检查方法：先核对必填字…" [level=1] [ref=f1e100]
      - generic [ref=f1e101]:
        - button "关闭结果" [ref=f1e102] [cursor=pointer]
        - button "任务更多操作" [ref=f1e104] [cursor=pointer]:
          - generic [aria-hidden] [ref=f1e105]: ⋯
    - generic [ref=f1e106]:
      - generic [ref=f1e107]: 来源：在回复中给一个三步数据质量检查方法：先核对必填字… · 1轮 · 截至10:33
      - generic [ref=f1e108]:
        - button "查看原任务" [ref=f1e109] [cursor=pointer]
        - button "补充最新记录" [ref=f1e111] [cursor=pointer]
    - generic [ref=f1e113]:
      - main "对话区" [ref=f1e114]:
        - feed [ref=f1e116]:
          - paragraph [ref=f1e121]: 从“在回复中给一个三步数据质量检查方法：先核对必填字…”提炼可复用技能。 提炼重点：将三步检查方法整理为可重复使用的中文技能，保留缺失字段先澄清和原始编号证据。输入字段与数据文件参数化。仅SKILL.md，不添加脚本或资源。 先调用 skill_drafts.get_skill_draft 读取所选记录与工作约定，然后通过 publish_skill_draft 发布完整草稿。只更新草稿，不改原产物、不安装技能。
          - generic [ref=f1e122]:
            - generic "回合处理时间" [ref=f1e123]: 已处理 1 分钟 28 秒
            - button "已思考 1 秒" [ref=f1e127] [cursor=pointer]
          - paragraph [ref=f1e134]: 我先读取关联草稿与来源记录，再发布完整的 SKILL.md 草稿。
          - group "操作记录，已完成" [ref=f1e136]:
            - button "操作记录：已调用工具，已完成" [ref=f1e137] [cursor=pointer]:
              - generic [ref=f1e143]: 已调用工具
          - button "已思考 34 秒" [ref=f1e151] [cursor=pointer]
          - paragraph [ref=f1e158]:
            - text: 已确认来源与当前修订。现在发布仅含
            - code [ref=f1e159]: SKILL.md
            - text: 的完整草稿，参数化数据文件与字段清单，并保留澄清与追溯要求。
          - group "操作记录，已完成" [ref=f1e161]:
            - button "操作记录：已调用工具，已完成，1 项操作失败" [ref=f1e162] [cursor=pointer]:
              - generic [ref=f1e168]: 已调用工具
              - generic [ref=f1e169]: 1 项操作失败
          - button "已思考 15 秒" [ref=f1e177] [cursor=pointer]
          - paragraph [ref=f1e184]:
            - code [ref=f1e185]: SKILL.md
            - text: 不能作为自定义资源路径提交；我改为把方法写入技能正文并保留空资源列表，以符合“仅 SKILL.md”的要求。
          - group "操作记录，已完成" [ref=f1e187]:
            - button "操作记录：已调用工具，已完成" [ref=f1e188] [cursor=pointer]:
              - generic [ref=f1e194]: 已调用工具
          - button "已思考 7 秒" [ref=f1e202] [cursor=pointer]
          - generic [ref=f1e208]:
            - paragraph [ref=f1e209]:
              - text: 已发布完整技能草稿
              - code [ref=f1e210]: 三步数据质量检查
              - text: （revision 1）。
            - list [ref=f1e211]:
              - listitem [ref=f1e212]: 将数据文件、必填字段、去重规则、勾稽字段和统计口径参数化。
              - listitem [ref=f1e213]: 保留三步检查、缺失字段先澄清、原始记录编号证据和独立勾稽要求。
              - listitem [ref=f1e214]: 仅保存为 SKILL.md 正文，未添加脚本或资源，也未安装技能。
            - paragraph [ref=f1e215]: 草稿已自动保留；你可在界面确认“保存并启用”后使用。
          - button "策略注入 · stop:4:/private/var/folders/b6/5bqgjcl54zd0_701jf9z8bl00000gn/T/evowork-ui-MeiM9L/.evowork/kernel/hooks.json" [ref=f1e219] [cursor=pointer]
          - button "已思考 5 秒" [ref=f1e224] [cursor=pointer]
          - group "操作记录，已完成" [ref=f1e228]:
            - button "操作记录：已调用工具，已完成" [ref=f1e229] [cursor=pointer]:
              - generic [ref=f1e235]: 已调用工具
          - paragraph [ref=f1e243]: 技能草稿已发布并登记为 revision 1；未改动原产物、未添加资源，也未安装技能。
        - region "输入区" [ref=f1e246]:
          - generic [ref=f1e248]:
            - combobox "需求输入" [ref=f1e249]
            - generic [ref=f1e250]:
              - button "添加内容" [ref=f1e252] [cursor=pointer]
              - button "审批档" [ref=f1e255] [cursor=pointer]:
                - generic [ref=f1e259]: 请求批准
                - generic [aria-hidden] [ref=f1e260]: ▾
              - button "选择项目" [ref=f1e262] [cursor=pointer]:
                - generic [ref=f1e266]: 不使用项目
              - button "选择模型" [ref=f1e268] [cursor=pointer]:
                - generic [ref=f1e269]: zhipu/glm-5.3-flash
                - generic [aria-hidden] [ref=f1e270]: ▾
              - button "发送" [disabled] [ref=f1e271]
      - complementary "结果区" [ref=f1e274]:
        - separator "调整结果区宽度" [ref=f1e275]
        - tablist "结果区视图" [ref=f1e276]:
          - tab "技能草稿" [selected] [ref=f1e277] [cursor=pointer]
        - region "技能草稿" [ref=f1e280]:
          - generic [ref=f1e281]:
            - strong [ref=f1e282]: 三步数据质量检查
            - generic [ref=f1e283]: 已启用
          - generic [ref=f1e285]:
            - text: 查看内容
            - combobox "查看内容" [ref=f1e286]:
              - option "可读预览" [selected]
              - option "SKILL.md"
          - generic [ref=f1e287]:
            - paragraph [ref=f1e288]: 按核对必填字段与行数、去重保留原始编号、独立勾稽总额三步检查表格数据，并先澄清缺失字段。
            - generic [ref=f1e289]:
              - heading "三步数据质量检查" [level=1] [ref=f1e290]
              - heading "适用场景" [level=2] [ref=f1e291]
              - paragraph [ref=f1e292]: 当用户提供一个数据文件，需要检查表格或台账类数据是否完整、可追溯、总额可信时使用。适用于 CSV、XLSX、数据库导出结果或其他结构化记录。
              - heading "每次需要的信息" [level=2] [ref=f1e293]
              - list [ref=f1e294]:
                - listitem [ref=f1e295]: 数据文件路径或数据来源标识。
                - listitem [ref=f1e296]: 必填字段清单；如未指定，先根据用户说明的口径提出候选必填字段并确认。
                - listitem [ref=f1e297]: 判定重复记录的字段组合或去重规则。
                - listitem [ref=f1e298]: 需要勾稽的数值字段，例如金额或数量。
                - listitem [ref=f1e299]: 统计口径、统计期间和是否需要输出检查结果文件。
              - heading "三步检查方法" [level=2] [ref=f1e300]
              - list [ref=f1e301]:
                - listitem [ref=f1e302]:
                  - paragraph [ref=f1e303]:
                    - strong [ref=f1e304]: 核对必填字段和行数
                  - list [ref=f1e305]:
                    - listitem [ref=f1e306]: 确认数据文件、统计口径、统计期间和字段清单。
                    - listitem [ref=f1e307]: 检查每条记录的必填字段是否齐全、类型是否正确，核对日期与金额单位是否一致。
                    - listitem [ref=f1e308]: 统计原始行数、有效行数和被排除行数，确认三者勾稽一致。
                - listitem [ref=f1e309]:
                  - paragraph [ref=f1e310]:
                    - strong [ref=f1e311]: 去重并保留原始记录编号
                  - list [ref=f1e312]:
                    - listitem [ref=f1e313]: 按用户确认的字段组合标记重复项，再决定保留哪一条。
                    - listitem [ref=f1e314]: 原始记录编号不同的记录不默认视为重复；编号应作为证据保留。
                    - listitem [ref=f1e315]: 输出结果必须能追溯到原始记录编号，必要时保留被排除记录及其编号和排除原因。
                - listitem [ref=f1e316]:
                  - paragraph [ref=f1e317]:
                    - strong [ref=f1e318]: 独立勾稽总额
                  - list [ref=f1e319]:
                    - listitem [ref=f1e320]: 用另一条独立计算路径重新汇总金额或数量，再与原表总额比对。
                    - listitem [ref=f1e321]: 分别核对合计、分类小计和差异项，确认缺失、去重或排除记录没有影响总额。
                    - listitem [ref=f1e322]: 若不一致，先列出差异明细和相关原始编号，不自行调整数据。
              - heading "缺失字段处理" [level=2] [ref=f1e323]
              - list [ref=f1e324]:
                - listitem [ref=f1e325]: 发现必填字段缺失时，列出字段名、涉及记录的原始编号和缺失数量。
                - listitem [ref=f1e326]: 先请用户确认处理口径，再继续统计；不要猜测填补，也不要静默排除记录。
              - heading "交付要求" [level=2] [ref=f1e327]
              - list [ref=f1e328]:
                - listitem [ref=f1e329]: 在结果中说明每项结论使用的数据文件、字段、统计口径和统计期间。
                - listitem [ref=f1e330]: 每个关键数字都应能追溯到原始记录编号；异常项单独列出。
                - listitem [ref=f1e331]: 明确报告缺失、重复、排除和勾稽差异；未完成的检查不要表述为已通过。
              - heading "复用边界" [level=2] [ref=f1e332]
              - list [ref=f1e333]:
                - listitem [ref=f1e334]: 不把具体文件名、业务字段、日期范围或数值写死；每次按用户提供的文件和口径执行。
                - listitem [ref=f1e335]: 缺失口径、去重规则和勾稽字段属于必须确认或显式授权的内容。
                - listitem [ref=f1e336]: 如用户只要检查方法或口头说明，不要自动创建输出文件；生成文件前确认目标格式和位置。
            - generic [ref=f1e337]:
              - strong [ref=f1e338]: 本次变化
              - list [ref=f1e339]:
                - listitem [ref=f1e340]: 创建三步数据质量检查技能草稿。
                - listitem [ref=f1e341]: 参数化数据文件、必填字段、去重规则和勾稽字段。
                - listitem [ref=f1e342]: 保留缺失字段先澄清、原始记录编号证据和独立勾稽总额要求。
                - listitem [ref=f1e343]: 仅提供 SKILL.md，不添加脚本或资源。
            - generic [ref=f1e344]:
              - strong [ref=f1e345]: 规则来源
              - generic [ref=f1e346]:
                - generic [ref=f1e347]: 用户要求的三步数据质量检查方法：核对必填字段和行数、去重并保留原始记录编号、独立勾稽总额；缺失字段先澄清，不猜测填补。
                - button "查看来源" [ref=f1e348] [cursor=pointer]
              - generic [ref=f1e350]:
                - generic [ref=f1e351]: 助手交付的检查细则包含口径确认、行数勾稽、按字段组合去重、保留原始编号、独立计算路径和差异明细处理。
                - button "查看来源" [ref=f1e352] [cursor=pointer]
              - generic [ref=f1e354]:
                - generic [ref=f1e355]: 助手说明在缺失必填字段时列出字段名、涉及记录编号和缺失数量，等待用户确认处理口径。
                - button "查看来源" [ref=f1e356] [cursor=pointer]
              - generic [ref=f1e358]:
                - generic [ref=f1e359]: 来源任务中用户限定当前回合不创建文件，技能将其泛化为仅在用户要求时生成输出文件。
                - button "查看来源" [ref=f1e360] [cursor=pointer]
            - generic [ref=f1e362]:
              - button "只保留分析方法" [ref=f1e363] [cursor=pointer]
              - button "参数每次指定" [ref=f1e365] [cursor=pointer]
          - generic [ref=f1e367]:
            - strong [ref=f1e368]: 已保存并启用
            - paragraph [ref=f1e369]: 可在本机所有任务中使用 · 尚未在新任务中试用
            - generic [ref=f1e370]:
              - button "用此技能新建任务" [ref=f1e371] [cursor=pointer]
              - button "查看技能" [ref=f1e373] [cursor=pointer]
```

# Test source

```ts
  9   |   registerModels: true,
  10  |   hostGateway: true,
  11  |   desktopEnv: {
  12  |     EVOWORK_UI_FOLLOW_UP_WIRE: '1',
  13  |     EVOWORK_UI_MEMORY_IMPORT: 'disabled',
  14  |   },
  15  | });
  16  | test.setTimeout(600_000);
  17  | const startup = (page) => page.evaluate(() => window.evowork.getStartup());
  18  | const history = (page, id) =>
  19  |   page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
  20  | const draftOf = (page, id) =>
  21  |   page.evaluate((threadId) => window.evowork.getSkillExtraction({ threadId }), id);
  22  | const calls = (h, tool) =>
  23  |   h.items.filter(
  24  |     (item) => item.type === 'mcpToolCall' && item.server === 'skill_drafts' && item.tool === tool,
  25  |   );
  26  | const guard = '不要联网、读取环境变量、读取工作目录外的文件或创建子任务。';
  27  | 
  28  | async function completed(page, id, count) {
  29  |   await expect
  30  |     .poll(
  31  |       async () => {
  32  |         const h = await history(page, id);
  33  |         const failed = h.turns.find((turn) => turn.status === 'failed');
  34  |         if (failed) throw new Error('真实模型回合失败：' + JSON.stringify(failed));
  35  |         const allow = page
  36  |           .getByLabel('需要你确认')
  37  |           .getByRole('button', { name: '允许这一次', exact: true });
  38  |         if (await allow.count())
  39  |           await allow
  40  |             .first()
  41  |             .click({ timeout: 2000 })
  42  |             .catch(() => {});
  43  |         return h.turns.length === count && h.turns.every((turn) => turn.status === 'completed');
  44  |       },
  45  |       { timeout: 180_000, intervals: [500, 1000, 2000] },
  46  |     )
  47  |     .toBe(true);
  48  |   await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  49  | }
  50  | 
  51  | async function send(page, text) {
  52  |   await page.getByLabel('需求输入').fill(text);
  53  |   await page.getByRole('button', { name: '发送', exact: true }).click();
  54  | }
  55  | 
  56  | async function reopen(page, id) {
  57  |   const task = (await startup(page)).tasks.find((item) => item.id === id);
  58  |   expect(task).toBeTruthy();
  59  |   await page.getByRole('button', { name: task.title, exact: true }).click();
  60  | }
  61  | 
  62  | async function sourceTask(page, electronApp, text, project = true) {
  63  |   if (project) await startTaskInWorkspace(page, electronApp, text);
  64  |   else await send(page, text);
  65  |   await expect.poll(async () => (await startup(page)).tasks.length).toBe(1);
  66  |   const task = (await startup(page)).tasks[0];
  67  |   await completed(page, task.id, 1);
  68  |   return task;
  69  | }
  70  | 
  71  | async function extractionTask(page, sourceId) {
  72  |   await expect
  73  |     .poll(async () => (await startup(page)).tasks.find((task) => task.id !== sourceId)?.id, {
  74  |       timeout: 180_000,
  75  |     })
  76  |     .toBeTruthy();
  77  |   const task = (await startup(page)).tasks.find((task) => task.id !== sourceId);
  78  |   await completed(page, task.id, 1);
  79  |   const draft = await draftOf(page, task.id);
  80  |   expect(draft.revision).toBeGreaterThan(0);
  81  |   expect(draft.content.instructions.length).toBeGreaterThan(100);
  82  |   expect(draft.content.sources.length).toBeGreaterThan(0);
  83  |   for (const rule of draft.content.sources)
  84  |     expect(draft.source.evidence.some((item) => item.id === rule.evidenceId)).toBe(true);
  85  |   const h = await history(page, task.id);
  86  |   expect(calls(h, 'get_skill_draft').some((item) => item.status === 'completed')).toBe(true);
  87  |   expect(calls(h, 'publish_skill_draft').some((item) => item.status === 'completed')).toBe(true);
  88  |   return { task, draft };
  89  | }
  90  | 
  91  | async function menuExtraction(page, sourceId, focus) {
  92  |   await page.getByRole('button', { name: '任务更多操作' }).click();
  93  |   await page.getByRole('menuitem', { name: '提炼为技能', exact: true }).click();
  94  |   const dialog = page.getByRole('dialog', { name: '从本任务提炼技能' });
  95  |   await dialog.getByLabel('提炼重点（可选）').fill(focus);
  96  |   await dialog.getByRole('button', { name: '开始提炼', exact: true }).click();
  97  |   return extractionTask(page, sourceId);
  98  | }
  99  | 
  100 | async function save(page, task) {
  101 |   await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  102 |   await expect
  103 |     .poll(async () => {
  104 |       const audit = page.getByRole('dialog').filter({ hasText: /我已了解|输入技能名/ });
  105 |       if (await audit.count()) {
  106 |         const checkbox = audit.getByRole('checkbox', { name: '我已了解' });
  107 |         if (await checkbox.count()) await checkbox.check();
  108 |         else {
> 109 |           const draft = await draftOf(page, task.id);
      |                              ^ Error: 文件已保存，正在核对启用状态。
  110 |           await audit.getByRole('textbox').fill(draft.content.slug);
  111 |         }
  112 |         await audit.getByRole('button', { name: '保存并启用', exact: true }).click();
  113 |       }
  114 |       const draft = await draftOf(page, task.id);
  115 |       if (draft.error) throw new Error(draft.error);
  116 |       return draft.state;
  117 |     })
  118 |     .toBe('saved');
  119 |   await expect(page.locator('.ew-skill-savebar')).toContainText('已保存并启用');
  120 |   const draft = await draftOf(page, task.id);
  121 |   expect(draft.installed.revision).toBe(draft.revision);
  122 |   expect(readFileSync(join(draft.installed.path, 'SKILL.md'), 'utf8')).toContain(
  123 |     draft.content.instructions.trim(),
  124 |   );
  125 |   return draft;
  126 | }
  127 | 
  128 | async function record(page, electronApp, info, strict = true) {
  129 |   const model = selectRealModel();
  130 |   const home = await electronApp.evaluate(() => globalThis.__evoworkE2E.home);
  131 |   const filename = join(home, 'follow-up-wire.jsonl');
  132 |   const wire = () =>
  133 |     existsSync(filename)
  134 |       ? readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  135 |       : [];
  136 |   if (strict) {
  137 |     await expect
  138 |       .poll(
  139 |         () => {
  140 |           const rows = wire();
  141 |           return rows.filter(
  142 |             (row) =>
  143 |               row.type === 'request' &&
  144 |               !rows.some(
  145 |                 (outcome) =>
  146 |                   outcome.type !== 'request' && outcome.pid === row.pid && outcome.id === row.id,
  147 |               ),
  148 |           ).length;
  149 |         },
  150 |         { timeout: 60000 },
  151 |       )
  152 |       .toBe(0);
  153 |     const rows = wire();
  154 |     const requests = rows.filter((row) => row.type === 'request');
  155 |     expect(requests.length).toBeGreaterThan(0);
  156 |     expect(requests.every((row) => row.model === model.upstreamModel)).toBe(true);
  157 |     expect(requests.every((row) => row.endpoint === model.baseUrl + '/chat/completions')).toBe(
  158 |       true,
  159 |     );
  160 |     expect(rows.filter((row) => row.type === 'response')).toHaveLength(requests.length);
  161 |     expect(rows.filter((row) => row.type === 'response').every((row) => row.status === 200)).toBe(
  162 |       true,
  163 |     );
  164 |     expect(rows.filter((row) => row.type === 'transport-error')).toEqual([]);
  165 |   }
  166 |   const tasks = (await startup(page)).tasks;
  167 |   const snapshots = [];
  168 |   for (const task of tasks) {
  169 |     const draft = await draftOf(page, task.id);
  170 |     snapshots.push({
  171 |       task,
  172 |       history: await history(page, task.id),
  173 |       draft,
  174 |       installedMarkdown: draft?.installed
  175 |         ? readFileSync(join(draft.installed.path, 'SKILL.md'), 'utf8')
  176 |         : null,
  177 |     });
  178 |   }
  179 |   const body = JSON.stringify(
  180 |     { model: model.upstreamModel, baseUrl: model.baseUrl, wire: wire(), snapshots },
  181 |     null,
  182 |     2,
  183 |   );
  184 |   if (process.env.EVOWORK_UI_MODEL_KEY && body.includes(process.env.EVOWORK_UI_MODEL_KEY))
  185 |     throw new Error('凭据扫描命中，拒绝保存证据');
  186 |   writeFileSync(info.outputPath('skill-extraction-real-evidence.json'), body);
  187 |   await page.screenshot({ path: info.outputPath('skill-extraction-real-final.png') });
  188 | }
  189 | 
  190 | test.afterEach(async ({ page, electronApp }, info) => {
  191 |   await record(page, electronApp, info, info.status === info.expectedStatus);
  192 | });
  193 | 
  194 | test('真实模型：项目提炼、来源追溯、对话修订、保存与新数据实际复用', async ({
  195 |   page,
  196 |   electronApp,
  197 | }, info) => {
  198 |   const root = realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
  199 |   const marker = randomBytes(5).toString('hex');
  200 |   const sourceFile = 'source-' + marker + '.json';
  201 |   const input = [
  202 |     { id: 'north', sales: randomInt(400, 700), refunds: randomInt(30, 90) },
  203 |     { id: 'south', sales: randomInt(40, 90), refunds: randomInt(100, 180) },
  204 |   ];
  205 |   writeFileSync(join(root, sourceFile), JSON.stringify(input));
  206 |   const source = await sourceTask(
  207 |     page,
  208 |     electronApp,
  209 |     `读取当前目录 ${sourceFile}，本机计算每行 net=sales-refunds，负值不得归零。写入 source-result.json，格式为 {"rows":[{"id":"原始id","net":整数}],"total":整数} 并读回核验；每行保留id作为证据。不要生成汇报。${guard}`,
```