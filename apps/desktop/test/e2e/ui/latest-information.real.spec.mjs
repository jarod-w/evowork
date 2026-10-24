/**
 * 真实模型、产品宿主网关、发货内核与随包 MCP；复用标准隔离 Electron 夹具。
 * 固定本机行情/新闻快照用于检验推理，不代表实时市场数据或搜索站点验收。
 * 密钥仅经 EVOWORK_UI_MODEL_KEY 传入，不写进测试文件或证据。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, startTaskInWorkspace, runUntilIdle, test } from './fixtures.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: { EVOWORK_UI_FOLLOW_UP_WIRE: '1' },
});

async function evidence(info, name, value) {
  const path = info.outputPath(name);
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (process.env.EVOWORK_UI_MODEL_KEY && body.includes(process.env.EVOWORK_UI_MODEL_KEY))
    throw new Error('测试证据包含凭据，拒绝落盘。');
  writeFileSync(path, body);
  await info.attach(name, { path });
}

function snapshot(workspace, winter) {
  const day = winter ? '2026-11-25' : '2026-10-23';
  const previous = winter ? '2026-11-24' : '2026-10-22';
  const offset = winter ? '-05:00' : '-04:00';
  const queryTime = winter ? '2026-11-27T09:06:00+08:00' : '2026-10-24T09:06:00+08:00';
  // 随机价格基数，避免模型按历史记忆填数；两种指数的单日涨跌刻意不同。
  const base = 20000 + Number.parseInt(randomBytes(2).toString('hex'), 16);
  const quotes = [
    { name: 'NASDAQ Composite', symbol: 'IXIC', previous_close: base, close: base * 0.9979 },
    {
      name: 'NASDAQ-100',
      symbol: 'NDX',
      previous_close: base + 1000,
      close: (base + 1000) * 0.99996,
    },
    {
      name: 'Dow Jones Industrial Average',
      symbol: 'DJI',
      previous_close: base + 2000,
      close: (base + 2000) * 0.9877,
    },
  ].map((quote) => ({
    ...quote,
    trade_date: day,
    session: 'regular_close',
    previous_trade_date: previous,
  }));
  writeFileSync(
    join(workspace, 'quotes.json'),
    JSON.stringify(
      {
        fixture: '离线验收快照，非实时行情',
        query_time: queryTime,
        user_timezone: 'Asia/Shanghai',
        market_timezone: 'America/New_York',
        calendar: winter
          ? [
              { date: previous, close: '16:00' },
              { date: day, close: '16:00' },
              { date: '2026-11-26', closed: true },
              { date: '2026-11-27', open: '09:30', close: '13:00' },
            ]
          : [
              { date: previous, close: '16:00' },
              { date: day, close: '16:00' },
              { date: '2026-10-24', closed: true },
            ],
        quotes,
      },
      null,
      2,
    ),
  );
  const stories = [
    [
      'N1',
      `${day}T08:14:00${offset}`,
      'Futures fall after Moderna crashes and AI selloff',
      `${day} 盘前回顾：上一交易日 ${previous} 纳斯达克综合跌 2.60%，Moderna 跌 17.57%。本段描述上一交易日，当前仅为期货盘前交易。`,
    ],
    [
      'N2',
      `${day}T15:25:00${offset}`,
      'Meta shares are down 9% this week',
      'Meta 过去五个交易日累计跌 9%。本文不提供它在最新一个交易日的涨跌，也没有证明该日新增了什么冲击。',
    ],
    [
      'N3',
      `${day}T16:20:00${offset}`,
      'Wall Street closes lower as oil and yields rise; tech steadies',
      `本文发布于收盘后，复盘 ${day} 正常交易时段：上午油价上涨，下午国债收益率走高，受访交易员将当日道指下跌归因于这两项因素；科技权重股整体接近平盘。`,
    ],
    [
      'N4',
      `${day}T18:49:00${offset}`,
      'AI supplier withdraws IPO after the closing bell',
      `${day} 美东 18:30，公司首次公开宣布撤回 IPO；报道确认这是正常交易时段结束后的新事件，没有盘中已公开的信息证据。`,
    ],
    [
      'N5',
      `${day}T16:30:00${offset}`,
      'Nasdaq-100 closes down 0.21%',
      `转述稿声称 ${day} 纳斯达克100（NDX）跌 0.21%，没有说明数据来源或基准；请以直接行情源核对。`,
    ],
  ];
  mkdirSync(join(workspace, 'news'));
  writeFileSync(
    join(workspace, 'news-index.json'),
    JSON.stringify(
      stories.map(([id, published, title]) => ({
        id,
        published,
        title,
        body_file: `news/${id}.html`,
      })),
      null,
      2,
    ),
  );
  for (const [id, published, title, body] of stories)
    writeFileSync(
      join(workspace, 'news', id + '.html'),
      `<article><h1>${title}</h1><time>${published}</time><p>${body}</p></article>`,
    );
  return { day, queryTime };
}

for (const winter of [false, true]) {
  test(`${winter ? '冬令时休市日' : '夏令时周末'}：事件时间、周度口径与相近指数不混用，建议标题完整`, async ({
    page,
    electronApp,
  }, info) => {
    test.setTimeout(360000);
    const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
    const expected = snapshot(workspace, winter);
    for (const name of ['quotes.json', 'news-index.json'])
      await evidence(info, name, JSON.parse(readFileSync(join(workspace, name), 'utf8')));
    for (const id of ['N1', 'N2', 'N3', 'N4', 'N5'])
      await evidence(
        info,
        id + '.html',
        readFileSync(join(workspace, 'news', id + '.html'), 'utf8'),
      );
    const marker = 'LATEST_' + randomBytes(4).toString('hex');
    try {
      await startTaskInWorkspace(
        page,
        electronApp,
        `${marker} 请根据本机已抓取的 quotes.json 和 news-index.json 及其正文文件，回答今天美股收盘如何、为什么。查询时间为 ${expected.queryTime}。这些是离线验收快照，只用本地材料，不联网、不启动子任务。\n` +
          '在回复里给结论，并保存 review.json：trade_date、indices（每项 name/symbol/change_pct，单位百分比）、news（每项 id/use/reason）、summary。use 只用“当日归因”“历史背景”“盘后新事件”“冲突待核验”，每条新闻均需分类并说明理由。数字从行情文件计算。\n' +
          '下一阶段我准备把复盘扩成两日对照表，本轮先不制作对照表。',
      );
      await runUntilIdle(page);
      const startup = await page.evaluate(() => window.evowork.getStartup());
      const task = startup.tasks.find((item) => item.title?.includes(marker));
      expect(task).toBeTruthy();
      // 任务投影使用网关命名空间；厂商模型和最终端点在 wire 证据中另行精确核对。
      expect(task.modelId).toBe('evowork/deepseek-flash');
      const history = await page.evaluate(
        (threadId) => window.evowork.openTask({ threadId }),
        task.id,
      );
      await evidence(info, 'history.json', history);
      expect(history.turns).toHaveLength(1);
      expect(history.turns.every((turn) => turn.status === 'completed')).toBe(true);
      const report = JSON.parse(readFileSync(join(workspace, 'review.json'), 'utf8'));
      await evidence(info, 'review.json', report);
      expect(report.trade_date).toBe(expected.day);
      for (const [symbol, change] of [
        ['IXIC', -0.21],
        ['NDX', -0.004],
        ['DJI', -1.23],
      ]) {
        const quote = report.indices.find((item) => item.symbol === symbol);
        expect(quote, symbol).toBeTruthy();
        expect(quote.change_pct).toBeCloseTo(change, 3);
        expect(quote.name).toMatch(
          symbol === 'NDX' ? /100/ : symbol === 'IXIC' ? /综合|Composite/i : /道|Dow/i,
        );
      }
      for (const [id, use] of [
        ['N1', '历史背景'],
        ['N2', '历史背景'],
        ['N3', '当日归因'],
        ['N4', '盘后新事件'],
        ['N5', '冲突待核验'],
      ])
        expect(report.news.find((item) => item.id === id)?.use, id).toBe(use);
      const proposals = history.items.filter(
        (item) => item.type === 'mcpToolCall' && item.tool === 'propose_next_actions',
      );
      expect(proposals).toHaveLength(1);
      const args =
        typeof proposals[0].arguments === 'string'
          ? JSON.parse(proposals[0].arguments)
          : proposals[0].arguments;
      expect(args.outcome).toBe('delivered');
      expect(args.actions.length).toBeGreaterThan(0);
      for (const action of args.actions) {
        expect(action.title.trim().length).toBeGreaterThan(0);
        expect(action.title.length).toBeLessThanOrEqual(80);
        expect(action.prompt.trim().length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(proposals[0].result)).toContain('"saved":true');
      const wire = readFileSync(join(dirname(workspace), 'follow-up-wire.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      await evidence(info, 'wire.json', wire);
      const requests = wire.filter((row) => row.type === 'request' && row.hasTemporalTask);
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (row) =>
            row.model === 'deepseek-flash' &&
            row.endpoint === 'https://api.deepseek.com/v1/chat/completions' &&
            row.hasTemporalRulesInSystem &&
            row.hasNextActionFieldRules,
        ),
      ).toBe(true);
      expect(wire.filter((row) => row.type === 'transport-error')).toHaveLength(0);
      expect(wire.filter((row) => row.type === 'response').every((row) => row.status === 200)).toBe(
        true,
      );
      await expect(page.getByLabel('下一步建议')).toBeVisible();
      await page.screenshot({ path: info.outputPath('verified.png') });
    } finally {
      if (!page.isClosed()) {
        await evidence(
          info,
          'final-ui.txt',
          await page
            .locator('body')
            .innerText()
            .catch(() => ''),
        );
        await page.screenshot({ path: info.outputPath('final-ui.png') }).catch(() => undefined);
        await evidence(
          info,
          'kernel-lifecycle.json',
          await electronApp.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle()),
        );
      }
    }
  });
}
