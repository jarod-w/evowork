# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: thread-communication.real.spec.mjs >> 真模型独立会话：代理工具请求批准后执行并回传
- Location: apps/desktop/test/e2e/ui/thread-communication.real.spec.mjs:99:3

# Error details

```
Error: locator.count: Target page, context or browser has been closed
```

# Test source

```ts
  18  |     .poll(
  19  |       async () =>
  20  |         (await page.evaluate(() => window.evowork.getStartup())).tasks.find((t) =>
  21  |           t.title?.includes(marker),
  22  |         )?.id,
  23  |       { timeout: 60000 },
  24  |     )
  25  |     .toBeTruthy();
  26  |   await idle(page);
  27  |   return (await page.evaluate(() => window.evowork.getStartup())).tasks.find((t) =>
  28  |     t.title?.includes(marker),
  29  |   );
  30  | }
  31  | async function setup(page, electronApp) {
  32  |   const run = Date.now().toString(36),
  33  |     privateText = `PRIVATE-${run}`;
  34  |   const target = await create(page, electronApp, `REAL-B-${run}`);
  35  |   await page.getByRole('button', { name: '新建任务', exact: true }).click();
  36  |   const source = await create(
  37  |     page,
  38  |     electronApp,
  39  |     `REAL-A-${run}`,
  40  |     '这是来源独有的背景资料。'.repeat(20) + privateText,
  41  |   );
  42  |   const answer = `ANSWER-${run}`;
  43  |   return {
  44  |     source,
  45  |     target,
  46  |     privateText,
  47  |     answer,
  48  |     request: `REQUEST-${run} 请计算 17 + 25。只回复“${answer}：42”，不要使用工具、联网、读写文件或继续发送消息。`,
  49  |   };
  50  | }
  51  | const records = (page, id) =>
  52  |   page.evaluate((threadId) => window.evowork.getCommunicationRecords({ threadId }), id);
  53  | async function evidence(page, testInfo, m) {
  54  |   const history = await page.evaluate(async (m) => {
  55  |     const source = await window.evowork.openTask({ threadId: m.source.id });
  56  |     const target = await window.evowork.openTask({ threadId: m.target.id });
  57  |     const records = await window.evowork.getCommunicationRecords({ threadId: m.source.id });
  58  |     return { source, target, records };
  59  |   }, m);
  60  |   const body = JSON.stringify({ model: selectRealModel().upstreamModel, ...history }, null, 2);
  61  |   writeFileSync(testInfo.outputPath('communication-history.json'), body);
  62  |   await testInfo.attach('communication-history', {
  63  |     body,
  64  |     contentType: 'application/json',
  65  |   });
  66  |   await page.screenshot({ path: testInfo.outputPath('communication.png'), fullPage: true });
  67  |   return history;
  68  | }
  69  | async function completed(page, testInfo, m, sourceTurns = 3) {
  70  |   await expect
  71  |     .poll(async () => (await records(page, m.source.id))[0]?.status, { timeout: 180000 })
  72  |     .toBe('completed');
  73  |   await idle(page);
  74  |   const history = await evidence(page, testInfo, m);
  75  |   expect(history.records).toHaveLength(1);
  76  |   expect(history.source.turns).toHaveLength(sourceTurns);
  77  |   expect(history.target.turns).toHaveLength(2);
  78  |   expect(history.records[0].reply).toContain(m.answer);
  79  |   expect(history.records[0].reply).toContain('42');
  80  |   expect(JSON.stringify(history.target.items)).not.toContain(m.privateText);
  81  |   const requests = history.target.items.filter(
  82  |     (i) => i.type === 'userMessage' && JSON.stringify(i.content).includes('[EvoWork 会话请求'),
  83  |   );
  84  |   expect(requests).toHaveLength(1);
  85  |   expect(JSON.stringify(requests[0])).toContain(m.request);
  86  |   const replies = history.source.items.filter(
  87  |     (i) => i.type === 'userMessage' && JSON.stringify(i.content).includes('[EvoWork 会话回复'),
  88  |   );
  89  |   expect(replies).toHaveLength(1);
  90  |   const final = history.source.items.filter(
  91  |     (i) => i.type === 'agentMessage' && i.phase !== 'commentary',
  92  |   );
  93  |   expect(final.at(-1)?.text).toContain('42');
  94  |   await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
  95  |   return history.records[0];
  96  | }
  97  |
  98  | for (const accept of [false, true]) {
  99  |   test(`真模型独立会话：代理工具请求${accept ? '批准后执行并回传' : '拒绝后零投递'}`, async ({
  100 |     page,
  101 |     electronApp,
  102 |   }, testInfo) => {
  103 |     const m = await setup(page, electronApp);
  104 |     try {
  105 |       await page
  106 |         .getByLabel('需求输入')
  107 |         .fill(
  108 |           `请给“${m.target.title}”任务（会话 ID：${m.target.id}）发送以下完整请求，并把结果返回这里：\n${m.request}\n发送前交给我确认目标和正文。发送后简短确认并结束当前回合，不轮询、不重试、不使用其他工具。收到回复后简短汇总并保留 ${m.answer}。`,
  109 |         );
  110 |       await page.getByRole('button', { name: '发送', exact: true }).click();
  111 |       const approval = page
  112 |         .getByRole('alertdialog')
  113 |         .filter({ has: page.getByRole('button', { name: '批准本次发送', exact: true }) });
  114 |       const native = page
  115 |         .getByRole('alertdialog')
  116 |         .filter({ has: page.getByRole('button', { name: '允许这一次', exact: true }) });
  117 |       await expect
> 118 |         .poll(async () => (await approval.count()) + (await native.count()), {
      |                                           ^ Error: locator.count: Target page, context or browser has been closed
  119 |           timeout: 120000,
  120 |         })
  121 |         .toBeGreaterThan(0);
  122 |       if (await native.count())
  123 |         await native.getByRole('button', { name: '允许这一次', exact: true }).click();
  124 |       await expect(approval).toBeVisible();
  125 |       await expect(approval).toContainText(m.target.id);
  126 |       await expect(approval).toContainText(m.request);
  127 |       expect(await records(page, m.source.id)).toHaveLength(0);
  128 |       await approval
  129 |         .getByRole('button', { name: accept ? '批准本次发送' : '拒绝', exact: true })
  130 |         .click();
  131 |       await idle(page);
  132 |       if (accept) {
  133 |         const record = await completed(page, testInfo, m);
  134 |         await expect(page.locator('.ew-conversation-scroll')).toContainText(m.answer);
  135 |         await page.reload();
  136 |         await page.getByRole('button', { name: m.source.title, exact: true }).click();
  137 |         await expect(page.getByText('会话通信', { exact: true })).toHaveCount(0);
  138 |         await expect(page.locator('.ew-conversation-scroll')).toContainText(m.answer);
  139 |         expect(await records(page, m.source.id)).toEqual([record]);
  140 |       } else {
  141 |         const history = await evidence(page, testInfo, m);
  142 |         expect(history.records).toHaveLength(0);
  143 |         expect(JSON.stringify(history.target.items)).not.toContain(m.request);
  144 |         expect(history.target.turns).toHaveLength(1);
  145 |       }
  146 |     } catch (error) {
  147 |       await evidence(page, testInfo, m).catch(() => undefined);
  148 |       throw error;
  149 |     }
  150 |   });
  151 | }
  152 |
```