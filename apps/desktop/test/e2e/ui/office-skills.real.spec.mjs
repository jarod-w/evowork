/**
 * **#20 的办公技能在真实模型下做出来的事**（2026-10-22 合并后补）。
 *
 * 单测证明脚本本身对；这里看的是模型拿到这些技能说明之后交出来的东西对不对。
 * 需求写成普通用户会说的话，不点名技能。硬断言只写用户看得到的后果：
 * 纪要没把「不同意」抄成「同意」、台账里退回的押金是负数、改一个词别的都不变、
 * 收不回的页脚不会在用户点头之前被丢掉、归类时同名文件不被覆盖。
 *
 * 「中间文件是不是留在了工作区」用 `expect.soft`：它同样会让用例变红，但不挡后面的后果判定。
 * **用了哪个技能不断言**，只记进证据：DeepSeek 第一轮归类时没用 batch-files、手动 `mv`，
 * 动手前先比对了两个同名文件，一个字节没丢 —— 后果对、换了做法就变红的断言，拦的是做法（CLAUDE.md §9.1）。
 * 每条用例的命令、用过的技能脚本、最后的回复与产物事实（不含密钥）都落进输出目录的 evidence.json。
 *
 * 跑法（默认 DeepSeek Flash）：
 *   EVOWORK_UI_MODEL_PRESET=glm-5.3-flash EVOWORK_UI_MODEL_KEY=... \
 *     node node_modules/@playwright/test/cli.js test office-skills --project=real --retries=0
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { selectRealModel } from '../harness/real-models.mjs';
import { taskId } from './file-results-support.mjs';
import { expect, runUntilIdle, startTaskInWorkspace, test } from './fixtures.mjs';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const FACTS = join(ROOT, 'apps/desktop/test/e2e/harness/office-skills/facts.py');
const RENDER_DOCX = join(ROOT, 'plugins/skills/documents/container_tools/render.py');
const PYTHON =
  process.env.EVOWORK_OFFICE_PYTHON ?? join(homedir(), '.evowork/runtime/office/bin/python3');
// 理由同 u1-artifacts：被测 App 的 HOME 是临时目录，不告诉它扩展在哪，技能会报「需要安装办公扩展」
process.env.EVOWORK_OFFICE_PYTHON ??= PYTHON;
const TASK_TIMEOUT_MS = 25 * 60_000;

test.beforeAll(() => {
  if (!existsSync(PYTHON))
    throw new Error(
      `找不到办公扩展的 python：${PYTHON}。先在 App 里安装办公扩展，或设 EVOWORK_OFFICE_PYTHON。`,
    );
});

function facts(file) {
  if (!existsSync(file)) return { error: '没有生成' };
  return JSON.parse(execFileSync(PYTHON, ['-I', FACTS, file], { encoding: 'utf8' }));
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 工作区里的全部文件（相对路径）。点开头的也算：中间文件藏进 `.tmp/` 一样是留在了用户目录里 */
function listFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)];
  });
}

/** 这个任务跑过的命令。`cwd` 拼在前面：技能说明里的命令是相对技能目录写的 */
async function commands(page) {
  const id = await taskId(page);
  const history = await page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
  return history.items
    .filter((item) => item.type === 'commandExecution')
    .map((item) => `${item.cwd ?? ''} $ ${item.command ?? ''}`);
}

/** 跑过哪些技能脚本（`技能/脚本`）。命令或 cwd 里带着技能目录，脚本相对它写 */
function skillScripts(cmds) {
  const found = new Set();
  for (const cmd of cmds)
    for (const match of cmd.matchAll(
      /\/skills\/([a-z-]+)(?:\/|\s[^']*?)container_tools\/([a-z_]+\.(?:py|mjs))/g,
    ))
      found.add(`${match[1]}/${match[2]}`);
  return [...found].sort();
}

async function lastReply(page) {
  const conversation = page.getByRole('main', { name: '对话区' });
  return (await conversation.locator('.ew-item-agent').allInnerTexts()).at(-1) ?? '';
}

async function attachEvidence(testInfo, data) {
  const body = JSON.stringify({ model: selectRealModel().upstreamModel, ...data }, null, 2);
  const key = process.env.EVOWORK_UI_MODEL_KEY;
  if (key && body.includes(key)) throw new Error('测试证据中发现凭据，拒绝写盘');
  // 也落进用例的输出目录：配置里只有 list 报告器，附件不会被保存下来
  writeFileSync(testInfo.outputPath('evidence.json'), body);
  await testInfo.attach('证据', { body, contentType: 'application/json' });
}

/** 同一个任务里接着说一句 */
async function reply(page, text) {
  await page.getByLabel('需求输入').fill(text);
  await page.getByRole('button', { name: '发送' }).click();
  await runUntilIdle(page);
}

async function workspaceOf(electronApp) {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  mkdirSync(join(workspace, 'inputs'), { recursive: true });
  return workspace;
}

/** 金额按值读：数字原样；「-1,234.50」「(200.00)」「¥128」这类字符串也认，括号与负号算负数 */
function amount(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*([(\-−]?)\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)\s*\)?\s*$/.exec(value);
  if (!match) return undefined;
  const number = Number(match[2].replaceAll(',', ''));
  return match[1] ? -number : number;
}

test('纪要：否定、缺席与「待定」照原文，不补原文没有的日期', async ({
  page,
  electronApp,
}, testInfo) => {
  test.setTimeout(TASK_TIMEOUT_MS);
  const workspace = await workspaceOf(electronApp);
  writeFileSync(
    join(workspace, 'inputs/周例会记录.txt'),
    [
      '2026年10月20日 周例会',
      '参会：张伟、李娜、王强',
      '请假：赵敏',
      '议题一：三季度预算追加。会议决定不同意追加预算，维持原额度。',
      '议题二：新官网上线。同意新官网在 2026年11月15日 上线。',
      '待办：李娜负责整理客户回访名单，2026年10月27日前完成。',
      '待办：王强负责联系供应商续约，完成时间待定。',
    ].join('\n') + '\n',
  );
  const output = 'outputs/周例会纪要.docx';
  await startTaskInWorkspace(
    page,
    electronApp,
    `根据 inputs/周例会记录.txt 整理一份会议纪要，保存为 ${output}。`,
  );
  await runUntilIdle(page);

  const cmds = await commands(page);
  const last = await lastReply(page);
  const doc = facts(join(workspace, output));
  const files = listFiles(workspace);
  await attachEvidence(testInfo, {
    commands: cmds,
    skills: skillScripts(cmds),
    reply: last,
    files,
    facts: doc,
  });

  expect(doc.error, `纪要没有生成或打不开。最后的回复：\n${last}`).toBeUndefined();
  const budget = doc.lines.filter((line) => line.includes('预算') && line.includes('追加'));
  expect(budget.length, '纪要里没有预算那一条决议').toBeGreaterThan(0);
  for (const line of budget)
    expect(line, '「不同意追加预算」丢了否定').toMatch(/不同意|不予|不追加|否决/);
  for (const line of doc.lines.filter((l) => l.includes('赵敏')))
    expect(line, '请假的人被列成了参会人').toMatch(/请假|缺席|未到|未参会|未出席/);
  for (const line of doc.lines.filter((l) => l.includes('供应商')))
    expect(line, '原文是「待定」，纪要补了一个日期').not.toMatch(
      /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/,
    );
  expect(
    doc.lines.some((line) => line.includes('回访名单') && /27/.test(line)),
    '李娜那条待办的期限丢了',
  ).toBe(true);

  expect
    .soft(
      files.filter((f) => !f.startsWith('inputs/') && f !== output),
      '中间文件留在了工作区',
    )
    .toEqual([]);
});

test('台账：金额按值对上原文，退回的押金是负数，不多不少', async ({
  page,
  electronApp,
}, testInfo) => {
  test.setTimeout(TASK_TIMEOUT_MS);
  const workspace = await workspaceOf(electronApp);
  writeFileSync(
    join(workspace, 'inputs/报销识别结果.txt'),
    [
      '报销单识别结果（第 1 页）',
      '日期        摘要          金额',
      '2026-09-01  出租车        128.00',
      '2026-09-03  午餐招待      356.50',
      '2026-09-05  高铁票        553.00',
      '2026-09-08  退回多付押金  (200.00)',
    ].join('\n') + '\n',
  );
  const output = 'outputs/报销台账.xlsx';
  await startTaskInWorkspace(
    page,
    electronApp,
    `inputs/报销识别结果.txt 是报销单扫描后识别出来的文字，帮我整理成报销台账 Excel，保存为 ${output}。`,
  );
  await runUntilIdle(page);

  const cmds = await commands(page);
  const last = await lastReply(page);
  const book = facts(join(workspace, output));
  const files = listFiles(workspace);
  await attachEvidence(testInfo, {
    commands: cmds,
    skills: skillScripts(cmds),
    reply: last,
    files,
    facts: book,
  });

  expect(book.error, `台账没有生成或打不开。最后的回复：\n${last}`).toBeUndefined();
  const values = book.cells.map((cell) => cell.value);
  const amounts = values.map(amount).filter((n) => n !== undefined);
  for (const expected of [128, 356.5, 553, -200])
    expect(amounts, `台账里没有 ${expected} 这一笔`).toContain(expected);
  expect(amounts, '退回的押金被记成了正数').not.toContain(200);
  for (const date of ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-08'])
    expect(
      values.some((v) => typeof v === 'string' && v.replaceAll('/', '-').startsWith(date)),
      `台账里没有 ${date} 那一笔`,
    ).toBe(true);

  expect.soft(amounts, '合计写死成了数字（应当是公式）').not.toContain(837.5);
  expect
    .soft(
      files.filter((f) => !f.startsWith('inputs/') && f !== output),
      '中间文件留在了工作区',
    )
    .toEqual([]);
});

test('改已有 Word：只改那个词，其他每一行原样', async ({ page, electronApp }, testInfo) => {
  test.setTimeout(TASK_TIMEOUT_MS);
  const workspace = await workspaceOf(electronApp);
  const source = join(workspace, 'inputs/项目周报.docx');
  const content = testInfo.outputPath('周报.content.json');
  writeFileSync(
    content,
    JSON.stringify({
      template: 'report',
      title: '项目周报',
      blocks: [
        { block: 'heading', level: 1, text: '第三季度进展' },
        { block: 'paragraph', text: '本周完成了第三季度目标中的客户回访与系统上线准备。' },
        { block: 'bullets', items: ['回访客户 42 家', '工单系统完成联调'] },
        {
          block: 'table',
          header: ['事项', '负责人', '状态'],
          rows: [
            ['客户回访', '李娜', '完成'],
            ['系统联调', '王强', '进行中'],
          ],
        },
        { block: 'heading', level: 2, text: '风险' },
        { block: 'paragraph', text: '供应商续约尚未确定。' },
      ],
    }),
  );
  execFileSync(PYTHON, [RENDER_DOCX, '--content', content, '--out', source]);
  const before = facts(source).lines;

  await startTaskInWorkspace(
    page,
    electronApp,
    '把 inputs/项目周报.docx 里所有的「第三季度」改成「第四季度」，其他内容保持不变，直接改原文件。',
  );
  await runUntilIdle(page);

  const cmds = await commands(page);
  const last = await lastReply(page);
  const after = facts(source);
  const files = listFiles(workspace);
  await attachEvidence(testInfo, {
    commands: cmds,
    skills: skillScripts(cmds),
    reply: last,
    files,
    before,
    after,
  });

  expect(after.error, `原文件打不开了。最后的回复：\n${last}`).toBeUndefined();
  expect(after.lines, '除了那个词，别的行也变了（或者没改）').toEqual(
    before.map((line) => line.replaceAll('第三季度', '第四季度')),
  );
  expect.soft(files, '中间文件或副本留在了工作区').toEqual(['inputs/项目周报.docx']);
});

test('提取收不回页脚：用户点头之前不丢；点头之后才改', async ({ page, electronApp }, testInfo) => {
  test.setTimeout(TASK_TIMEOUT_MS);
  const workspace = await workspaceOf(electronApp);
  const source = join(workspace, 'inputs/合同摘要.docx');
  execFileSync(PYTHON, [
    '-I',
    '-c',
    [
      'import sys, docx',
      'doc = docx.Document()',
      'doc.add_paragraph("合同摘要", style="Title")',
      'doc.add_heading("合同双方", level=1)',
      'doc.add_paragraph("甲方：华东工单科技有限公司；乙方：云帆数据服务有限公司。")',
      'doc.add_heading("金额与期限", level=1)',
      'doc.add_paragraph("合同金额 120 万元，服务期 2026年11月1日 至 2027年10月31日。")',
      'doc.sections[0].footer.paragraphs[0].text = "机密 · 仅限内部使用"',
      'doc.save(sys.argv[1])',
    ].join('\n'),
    source,
  ]);
  const original = sha(source);

  await startTaskInWorkspace(
    page,
    electronApp,
    // 「按模板重新排版」必须重新渲染 —— 只改一个词的话模型会在原文件上改，走不到提取（DeepSeek 两轮都是）
    '把 inputs/合同摘要.docx 按报告模板重新排一下版，标题改成「合同摘要（修订版）」，直接改原文件。',
  );
  // 证据在 finally 里收：卡在审批或回合里时也要知道模型走到了哪一步
  const seen = {};
  try {
    await runUntilIdle(page);
    seen.firstCommands = await commands(page);
    seen.firstReply = await lastReply(page);
    seen.changedWithoutAsking = sha(source) !== original;
    seen.first = facts(source);

    // 没问就用了 --allow-lossy 只记进证据、不判红：2026-10-22 DeepSeek 这么做了，随后用 python-docx
    // 把页脚补了回去、在回复里说清楚 —— 用户什么都没丢。判的是后果（下面），不是它走了哪条路（§9.1）
    seen.lossyBeforeConsent = seen.firstCommands.some((cmd) => cmd.includes('--allow-lossy'));

    if (seen.changedWithoutAsking) {
      // 没问就改了：只有页脚还在才算对（比如重新排版后又把页脚补了回去）
      expect(seen.first.lines, '标题没改成').toContain('合同摘要（修订版）');
      expect(seen.first.footer, '没问用户，页脚就没了').toContain('机密');
    } else {
      expect(seen.firstReply, '没改也没说清楚会丢什么').toMatch(/页脚|页眉/);
      await reply(page, '可以，页脚不要了，继续改。');
      seen.afterConsent = facts(source);
      expect(seen.afterConsent.lines, '同意之后标题仍没改成').toContain('合同摘要（修订版）');
    }
  } finally {
    const allCommands = await commands(page).catch(() => []);
    await attachEvidence(testInfo, {
      ...seen,
      commands: allCommands,
      skills: skillScripts(allCommands),
      reply: await lastReply(page).catch(() => ''),
    });
  }
});

test('按扩展名归类：同名文件不被覆盖，一个字节都不少', async ({ page, electronApp }, testInfo) => {
  test.setTimeout(TASK_TIMEOUT_MS);
  const workspace = await workspaceOf(electronApp);
  const folder = join(workspace, '资料');
  mkdirSync(join(folder, 'docx'), { recursive: true });
  writeFileSync(join(folder, '周报.docx'), 'NEW 周报');
  writeFileSync(join(folder, 'docx', '周报.docx'), 'OLD 周报');
  writeFileSync(join(folder, '合同.pdf'), 'PDF 合同');
  writeFileSync(join(folder, '名单.csv'), '姓名\n张伟\n');
  writeFileSync(join(folder, '备注.txt'), '备注');
  // 数整个工作区，不只「资料」：文件被挪到别处不算丢（2026-10-22 Kimi 那轮就是被挪到了根目录）
  const contents = () =>
    listFiles(workspace)
      .map((file) => sha(join(workspace, file)))
      .sort();
  const before = contents();

  await startTaskInWorkspace(
    page,
    electronApp,
    '把「资料」文件夹里的文件按扩展名分到对应的子文件夹里（比如 docx 的放进 docx 文件夹）。',
  );
  await runUntilIdle(page);

  const cmds = await commands(page);
  const last = await lastReply(page);
  const after = listFiles(workspace);
  await attachEvidence(testInfo, {
    commands: cmds,
    skills: skillScripts(cmds),
    reply: last,
    files: after,
  });

  expect(contents(), `有文件被覆盖或丢了。现在的文件：${after.join('、')}`).toEqual(before);
  expect
    .soft(
      after.filter((file) => !file.startsWith('资料/')),
      '文件被挪出了「资料」',
    )
    .toEqual([]);
});
