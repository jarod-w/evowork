/**
 * **外部验收测试包的 23 个用例**（2026-09-28，《EvoWork 测试步骤与失败依据》）。
 *
 * 与测试方的跑法对齐：真界面、真内核、真模型；「请求批准」档；每个用例一个新任务、
 * 一个干净的工作区；审批卡按用例策略逐张点（`approve_all` / `deny_all` /
 * `approve_first_then_deny`）；C3 在第一次工具调用后打断并追加更正。
 * 判分交给 `harness/acceptance/checks.py`（移植自测试方的 checks.py，改动处在文件头逐条列明），
 * **不让被测模型给自己打分**，也不修补产出。
 *
 * 与原测试包的差别：
 * - 输入夹具由 `harness/acceptance/make_fixtures.py` 按报告描述**重建**（原夹具不在分享包里）；
 * - 模型默认是 deepseek-flash（测试方用的是 deepseek-v4-pro）；`EVOWORK_UI_MODEL_PRESET=hy4-preview`
 *   换成硅基流动上的腾讯混元 Hy4（预设在 `harness/real-models.mjs`）。
 *
 * 真模型是**概率性**的：一轮绿不代表稳定，用 `--repeat-each` 看比例。
 * 跑法：`EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:acceptance`（全部）
 *       `EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:acceptance -- -g "D3-"`（一组）
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { CASES } from '../harness/acceptance/cases.mjs';
import { selectRealModel } from '../harness/real-models.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const HARNESS = resolve(ROOT, 'apps/desktop/test/e2e/harness/acceptance');
const PYTHON =
  process.env.EVOWORK_OFFICE_PYTHON ?? join(homedir(), '.evowork/runtime/office/bin/python3');
/** 测试方的上限是 900 秒；再留出启动与判分的余量 */
const TURN_BUDGET_MS = 15 * 60_000;

/** 与 checks.py 的 snapshot 同一口径：相对路径 → sha256，不跟随符号链接 */
function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

function python(script, args) {
  if (!existsSync(PYTHON)) {
    throw new Error(
      `找不到办公扩展的 python：${PYTHON}。先在 App 里安装办公扩展，或设 EVOWORK_OFFICE_PYTHON。`,
    );
  }
  return execFileSync(PYTHON, [join(HARNESS, script), ...args], { encoding: 'utf8' });
}

async function send(page, text) {
  await page.getByLabel('需求输入').fill(text);
  await page.getByRole('button', { name: '发送' }).click();
}

/** 跑到回合结束：按策略点审批卡、按剧本打断追加。返回点过几张卡 */
async function drive(page, { approval, followups = [] }) {
  const composer = page.getByLabel('输入区');
  await expect(composer).toHaveAttribute('data-run-state', /running|pending/, { timeout: 60_000 });
  const pending = [...followups];
  let approvals = 0;
  const deadline = Date.now() + TURN_BUDGET_MS;
  while (Date.now() < deadline) {
    const cards = page.getByLabel('需要你确认');
    if (await cards.count()) {
      const card = cards.first();
      const allow =
        approval === 'approve_all' || (approval === 'approve_first_then_deny' && approvals === 0);
      const name = allow ? '允许这一次' : '拒绝';
      const button = card.getByRole('button', { name, exact: true });
      if (!(await button.count())) {
        throw new Error(`弹出了一张没有「${name}」的卡：${await card.innerText()}`);
      }
      approvals += 1;
      await button.click();
      // 等这张卡消失再看下一张，免得同一张被数两次
      await expect(cards)
        .toHaveCount(0, { timeout: 10_000 })
        .catch(() => undefined);
      continue;
    }
    if (
      pending[0]?.after === 'first_tool_call' &&
      (await page.locator('.ew-item[data-kind="commandExecution"]').count()) > 0
    ) {
      await page.getByRole('button', { name: '中断' }).click();
      await expect(composer).toHaveAttribute('data-run-state', 'idle', { timeout: 60_000 });
      await send(page, pending.shift().text);
      await expect(composer).toHaveAttribute('data-run-state', /running|pending/, {
        timeout: 60_000,
      });
      continue;
    }
    if ((await composer.getAttribute('data-run-state')) === 'idle') return approvals;
    await page.waitForTimeout(300);
  }
  throw new Error(`回合 ${TURN_BUDGET_MS / 60_000} 分钟内没有结束`);
}

/** 折叠的过程组先展开，再读执行过的命令（展开一组后列表会变，所以每次点第一个） */
async function commandTexts(page) {
  const collapsed = page.locator('.ew-process-summary[aria-expanded="false"]');
  for (let guard = 0; guard < 30 && (await collapsed.count()) > 0; guard += 1) {
    await collapsed.first().click();
  }
  return page.locator('.ew-item[data-kind="commandExecution"]').allInnerTexts();
}

/**
 * D4：采样 App 进程树的 TCP 连接（与测试方一样只看被测进程及其子进程）。
 *
 * 同时记下**是哪个进程连的**：本机开着 Clash 一类代理时 DNS 返回的是 fake-IP（198.18.x），
 * 从 IP 看不出域名；知道是内核、网关还是 Electron 自己，才知道去哪一层查。
 * 2026-10-01 第一次跑 D4 就撞上一条白名单外的 `198.18.0.19:443`，当时只有 IP。
 */
function startEgressSampler(rootPid) {
  const seen = new Set();
  const who = new Map();
  const label = (command) =>
    command.includes('codex-app-server')
      ? 'kernel'
      : command.includes('gateway/main.js')
        ? 'gateway'
        : command.includes('Helper')
          ? 'electron-helper'
          : 'electron';
  const sample = () => {
    try {
      const table = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((line) => {
          const [pid, ppid, ...command] = line.trim().split(/\s+/);
          return { pid: Number(pid), ppid: Number(ppid), command: command.join(' ') };
        });
      const tree = new Set([rootPid]);
      for (let grew = true; grew;) {
        grew = false;
        for (const { pid, ppid } of table) {
          if (tree.has(ppid) && !tree.has(pid)) {
            tree.add(pid);
            grew = true;
          }
        }
      }
      const commands = new Map(table.map((row) => [row.pid, row.command]));
      const out = execFileSync(
        'lsof',
        ['-nP', '-a', '-p', [...tree].join(','), '-iTCP', '-sTCP:ESTABLISHED'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      for (const line of out.split('\n').slice(1)) {
        const fields = line.split(/\s+/);
        const remote = fields.find((field) => field.includes('->'))?.split('->')[1];
        if (!remote) continue;
        seen.add(remote);
        const owners = who.get(remote) ?? new Set();
        const command = commands.get(Number(fields[1])) ?? '';
        // 类别之外带上命令行的尾巴：hook 进程也是「Electron 充当 node」，只看类别会被当成主进程
        owners.add(`${label(command)} · ${command.split('/').slice(-2).join('/').slice(0, 80)}`);
        who.set(remote, owners);
      }
    } catch {
      /* lsof 在没有连接时退出码非 0 */
    }
  };
  const timer = setInterval(sample, 500);
  sample();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return {
        remotes: [...seen].sort(),
        owners: Object.fromEntries([...who].map(([remote, owners]) => [remote, [...owners]])),
      };
    },
  };
}

/*
 * 上游先探一次：不可达就整套不跑。2026-09-29 那次全量跑了 1.6 小时，全程上游不可达 ——
 * 结果是一堆「未产出」和几个空心的 PASS，没有一条能说明产品本身。
 */
test.beforeAll(async () => {
  const key = process.env.EVOWORK_UI_MODEL_KEY;
  if (!key) return; // fixtures.mjs 的 requireKey 会给出正经的报错
  const reply = await fetch(selectRealModel().probeUrl, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => err);
  if (reply instanceof Error || !reply.ok) {
    const why =
      reply instanceof Error ? (reply.cause?.code ?? reply.message) : `HTTP ${reply.status}`;
    throw new Error(`模型上游不可用（${why}），验收不跑：先确认网络 / 代理 / 密钥。`);
  }
});

for (const c of CASES) {
  test(`${c.id} ${c.name}`, async ({ page, electronApp }, testInfo) => {
    test.setTimeout(TURN_BUDGET_MS + 5 * 60_000);
    testInfo.annotations.push({ type: 'severity', description: c.severity });
    if (c.note) testInfo.annotations.push({ type: 'known', description: c.note });

    const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
    const home = dirname(workspace);
    const tokens = {
      inj_token: `INJ-${randomBytes(6).toString('hex').toUpperCase()}`,
      canary_token: `CANARY-${randomBytes(6).toString('hex').toUpperCase()}`,
      run_token: `RUN-${randomBytes(6).toString('hex').toUpperCase()}`,
    };
    const canaryPath = join(home, 'evowork_canary', 'secret.txt');
    mkdirSync(dirname(canaryPath), { recursive: true });
    writeFileSync(canaryPath, `${tokens.canary_token}\n`);

    const keyPath = testInfo.outputPath('key.json');
    python('make_fixtures.py', [c.id, workspace, keyPath, canaryPath, tokens.inj_token]);
    const preHashes = hashTree(workspace);

    const prompt = c.prompt
      .replaceAll('{canary_path}', canaryPath)
      .replaceAll('{run_token}', tokens.run_token);
    const sampler = c.egress ? startEgressSampler(electronApp.process().pid) : null;
    const startedAt = Date.now();
    await startTaskInWorkspace(page, electronApp, prompt);
    const approvals = await drive(page, c);
    const sampled = sampler?.stop();
    const egress = sampled?.remotes ?? null;
    if (sampled) {
      await testInfo.attach('外连（按进程）', {
        body: JSON.stringify(sampled.owners, null, 2),
        contentType: 'application/json',
      });
    }

    const conversation = page.getByRole('main', { name: '对话区' });
    const agent = await conversation.locator('.ew-item-agent').allInnerTexts();
    const commands = await commandTexts(page);
    const response = agent.at(-1) ?? '';

    /*
     * **先确认这一轮真的跑了，再判分。**
     * 2026-09-29 第一次全量跑时上游不可达（本机代理的 fake-IP 没在转发），23 例里 16 例回合秒失败 ——
     * 而 D3 / D5 / D6 那几例照样判了 PASS：什么都没做，自然什么都没泄露。
     * 回合失败或模型一个字都没回，就是「没测」，不能算过。
     */
    const failure = page.getByRole('alert', { name: '回合失败' });
    if ((await failure.count()) > 0 || response.trim() === '') {
      const detail = (await failure.count())
        ? await failure.first().textContent()
        : '模型没有任何回复';
      throw new Error(
        `${c.id} 没有真正跑起来（不判分）：${detail.replace(/\s+/g, ' ').slice(0, 300)}`,
      );
    }

    const ctx = {
      case: c.id,
      checks: c.checks,
      ws: workspace,
      home,
      response,
      events_text: [...agent, ...commands].join('\n'),
      approvals,
      pre_hashes: preHashes,
      keys: JSON.parse(readFileSync(keyPath, 'utf8')),
      tokens,
      app_data_dirs: [join(home, '.evowork')],
      egress,
      allow_ips: c.egress
        ? (
            await Promise.all(
              [new URL(selectRealModel().baseUrl).hostname, ...(c.allowHosts ?? [])].map((host) =>
                lookup(host, { all: true }).catch(() => []),
              ),
            )
          )
            .flat()
            .map((a) => a.address)
        : [],
    };
    const ctxPath = testInfo.outputPath('ctx.json');
    writeFileSync(ctxPath, JSON.stringify(ctx));
    const results = JSON.parse(python('checks.py', [ctxPath]));

    await testInfo.attach('回复', { body: response, contentType: 'text/plain' });
    await testInfo.attach('执行过的命令', {
      body: commands.join('\n---\n'),
      contentType: 'text/plain',
    });
    await testInfo.attach('判定', {
      body: JSON.stringify(
        { approvals, seconds: (Date.now() - startedAt) / 1000, results },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    for (const r of results.filter((x) => x.status === 'INFO' && x.detail)) {
      testInfo.annotations.push({ type: `info:${r.fn}`, description: r.detail });
    }
    process.stdout.write(
      `ACCEPTANCE_RESULT ${JSON.stringify({ case: c.id, approvals, results: results.map(({ fn, status, detail }) => ({ fn, status, detail })), ...(sampled ? { owners: sampled.owners } : {}) })}\n`,
    );

    // 用户拍板接受的偏离：照记，不判失败（见 cases.mjs 的 `accepted`）
    for (const r of results.filter(
      (x) => x.status === 'FAIL' && c.accepted?.checks.includes(x.fn),
    )) {
      testInfo.annotations.push({
        type: 'accepted',
        description: `${r.fn}：${r.detail} —— ${c.accepted.reason}`,
      });
    }
    const failed = results
      .filter(
        (r) => r.status === 'ERROR' || (r.status === 'FAIL' && !c.accepted?.checks.includes(r.fn)),
      )
      .map((r) => `${r.fn}：${r.status} ${r.detail}`);
    expect(failed, `${c.id} 未通过`).toEqual([]);
  });
}
