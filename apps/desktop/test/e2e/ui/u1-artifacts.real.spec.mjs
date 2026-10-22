/**
 * **U1：GLM-5.3-flash 撑不撑得住办公产物质量**（R4，08 §5.4）—— 给人工评分备齐材料。
 *
 * 08 §5.4 定了三个任务、四项标准（文字不溢出 · 公式可用 · 中文不乱码 · 层级正确，四项全过才达标），
 * 但从 M0 起一直没人评过：每次都要有人手工准备输入、一条条下需求、再去找产物。
 * 这个文件把「准备」那一半做掉：用固定种子的输入跑三个任务，产物收进一个目录，
 * 再按产物读出机器能确定的事实（页数、表格、目录、公式、字体），生成一张留给人填的评分表。
 *
 * **不替人打分**：溢出与乱码要看渲染出来的样子，这里判不了；断言只管「产物生成出来了、打得开」。
 * 评分表在 `test-results/u1-scoring/评分表.md`，产物在同目录 `artifacts/`。
 *
 * 跑法（默认 DeepSeek Flash；U1 要评的是 GLM）：
 *   EVOWORK_UI_MODEL_PRESET=glm-5.3-flash EVOWORK_UI_MODEL_KEY=... \
 *     node node_modules/@playwright/test/cli.js test u1-artifacts --project=real --retries=0
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { selectRealModel } from '../harness/real-models.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const HARNESS = join(ROOT, 'apps/desktop/test/e2e/harness/u1');
const PYTHON =
  process.env.EVOWORK_OFFICE_PYTHON ?? join(homedir(), '.evowork/runtime/office/bin/python3');
/*
 * 被测 App 的 HOME 是夹具的临时目录，那里没有 `~/.evowork/runtime/office` —— 不告诉它扩展在哪，
 * 技能会报「需要安装办公扩展」，模型随后满机器找 python（2026-10-22 第一次跑就是这样超时的）。
 * 夹具把父进程的环境原样交给 App，所以在这里设一次就够。真实安装里 HOME 是用户主目录，没有这个问题。
 */
process.env.EVOWORK_OFFICE_PYTHON ??= PYTHON;
/** 三个任务都是长回合（16 页 PPT 那次 12 分钟）：用例级超时要比 runUntilIdle 的 20 分钟宽 */
const TASK_TIMEOUT_MS = 25 * 60_000;

/** 08 §5.4 的三个任务。需求写成普通用户会说的话，不点名技能 —— 选不选对技能也是被评的一部分 */
const TASKS = [
  {
    id: '①',
    name: 'Excel → 8 页 PPT',
    output: 'outputs/季度销售汇报.pptx',
    prompt:
      '读取 inputs/销售数据.xlsx，做一份 8 页的季度销售汇报 PPT，保存为 outputs/季度销售汇报.pptx。' +
      '要有封面、目录、按区域和按产品的分析、月度趋势和结论。',
    criteria: ['文字不溢出', '中文不乱码', '层级正确'],
  },
  {
    id: '②',
    name: '需求 → 6 页 Word（含表格与目录）',
    output: 'outputs/项目方案.docx',
    prompt:
      '根据下面的需求写一份约 6 页的项目方案 Word 文档，保存为 outputs/项目方案.docx。' +
      '要有目录、清晰的标题层级，至少两张表格（里程碑计划、预算）。\n' +
      '需求：公司准备在华东区上线一套客户服务工单系统，替换现在用邮件和表格派单的做法。' +
      '目标是三个月内覆盖 4 个城市的 60 名客服，工单首次响应时间从 8 小时降到 2 小时以内。' +
      '预算上限 120 万元，需要和现有的 CRM 打通客户资料，并且要有手机端。',
    criteria: ['文字不溢出', '中文不乱码', '层级正确'],
  },
  {
    id: '③',
    name: 'csv → 含公式的 xlsx',
    output: 'outputs/费用汇总.xlsx',
    prompt:
      '读取 inputs/费用明细.csv，生成 outputs/费用汇总.xlsx：保留一张明细表，另建一张汇总表，' +
      '按部门和月份汇总金额。汇总表必须用公式（比如 SUMIFS）引用明细表计算，不要写死数字。',
    criteria: ['文字不溢出', '公式可用', '中文不乱码', '层级正确'],
  },
];
const ALL_CRITERIA = ['文字不溢出', '公式可用', '中文不乱码', '层级正确'];

/** 跑到回合结束，审批一律「允许这一次」（与验收的 approve_all 同） */
async function runUntilIdle(page) {
  const composer = page.getByLabel('输入区');
  await expect(composer).toHaveAttribute('data-run-state', /running|pending/, { timeout: 60_000 });
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const card = page.getByLabel('需要你确认');
    if (await card.count()) {
      const allow = card.first().getByRole('button', { name: '允许这一次', exact: true });
      if (!(await allow.count()))
        throw new Error(`弹出了一张没有「允许这一次」的卡：${await card.first().innerText()}`);
      // 数到卡和点下去之间，卡可能已经收掉了（回合往前走了）：点不到就回到循环里重新看
      await allow.click({ timeout: 5_000 }).catch(() => undefined);
      continue;
    }
    if ((await composer.getAttribute('data-run-state')) === 'idle') return;
    await page.waitForTimeout(500);
  }
  throw new Error('回合 20 分钟内没有结束');
}

const results = [];

test.beforeAll(() => {
  if (!existsSync(PYTHON))
    throw new Error(
      `找不到办公扩展的 python：${PYTHON}。先在 App 里安装办公扩展，或设 EVOWORK_OFFICE_PYTHON。`,
    );
});

for (const task of TASKS) {
  test(`U1 ${task.id} ${task.name}`, async ({ page, electronApp }, testInfo) => {
    test.setTimeout(TASK_TIMEOUT_MS);
    const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
    execFileSync(PYTHON, ['-I', join(HARNESS, 'make_inputs.py'), join(workspace, 'inputs')]);
    mkdirSync(join(workspace, 'outputs'), { recursive: true });

    const startedAt = Date.now();
    await startTaskInWorkspace(page, electronApp, task.prompt);
    await runUntilIdle(page);
    const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);

    const produced = join(workspace, task.output);
    const kept = join(testInfo.project.outputDir, 'u1-scoring', 'artifacts');
    mkdirSync(kept, { recursive: true });
    let facts = { error: '没有生成产物' };
    if (existsSync(produced)) {
      copyFileSync(produced, join(kept, `${task.id}-${task.output.split('/').pop()}`));
      facts = JSON.parse(
        execFileSync(PYTHON, ['-I', join(HARNESS, 'facts.py'), produced], { encoding: 'utf8' }),
      );
    }
    const conversation = page.getByRole('main', { name: '对话区' });
    const reply = (await conversation.locator('.ew-item-agent').allInnerTexts()).at(-1) ?? '';
    await testInfo.attach('产物事实', {
      body: JSON.stringify(facts, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('最后的回复', { body: reply, contentType: 'text/plain' });
    results.push({ task, minutes, facts });

    expect(existsSync(produced), `${task.output} 没有生成。最后的回复：\n${reply}`).toBe(true);
    expect(facts.error, `产物打不开：${facts.error}`).toBeUndefined();
  });
}

// eslint-disable-next-line no-empty-pattern -- Playwright 要求第一个参数写成解构；这里不用任何夹具
test.afterAll(async ({}, testInfo) => {
  if (results.length === 0) return;
  const model = selectRealModel();
  const dir = join(testInfo.project.outputDir, 'u1-scoring');
  mkdirSync(dir, { recursive: true });
  const lines = [
    '# U1 产物质量评分（08 §5.4）',
    '',
    `模型：${model.displayName}（\`${model.name}\`） · 生成：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    '四项全过才算达标；不达标按 R4 换旗舰档，**不靠加模板硬扛**。产物在 `artifacts/`，用 Office / WPS 打开逐页看。',
    '',
    '## 自动统计的事实（只列事实，不打分）',
    '',
    ...results.flatMap(({ task, minutes, facts }) => [
      `### ${task.id} ${task.name}（${minutes} 分钟）`,
      '',
      '```json',
      JSON.stringify(facts, null, 2),
      '```',
      '',
    ]),
    '## 人工评分',
    '',
    `| 任务 | ${ALL_CRITERIA.join(' | ')} | 备注 |`,
    `| --- | ${ALL_CRITERIA.map(() => '---').join(' | ')} | --- |`,
    ...results.map(
      ({ task }) =>
        `| ${task.id} ${task.name} | ${ALL_CRITERIA.map((c) => (task.criteria.includes(c) ? '☐' : '—')).join(' | ')} |  |`,
    ),
    '',
    '评分人：______  日期：______  结论：☐ 达标 · ☐ 不达标（换旗舰档）',
    '',
  ];
  writeFileSync(join(dir, '评分表.md'), lines.join('\n'));
  process.stdout.write(`U1_SCORING_SHEET ${join(dir, '评分表.md')}\n`);
});
