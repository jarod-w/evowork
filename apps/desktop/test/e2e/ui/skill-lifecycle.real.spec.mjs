import { randomBytes, randomInt } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.mjs';
import { selectRealModel } from '../harness/real-models.mjs';

test.use({ desktopEnv: { EVOWORK_UI_FOLLOW_UP_WIRE: '1', EVOWORK_UI_MEMORY_IMPORT: 'disabled' } });
test.setTimeout(600_000);

test('审计快照、单份存储、仅手动调用、更新和卸载经过真实模型执行', async ({
  page,
  electronApp,
}, info) => {
  const name = 'lifecycle-calculator';
  const { home, workspace } = await electronApp.evaluate(() => ({
    home: globalThis.__evoworkE2E.home,
    workspace: globalThis.__evoworkE2E.workspace,
  }));
  const installed = join(home, '.evowork', 'skills', name);
  const legacy = join(home, '.evowork', 'kernel', 'skills', name);
  const source = info.outputPath('source');
  mkdirSync(join(source, 'scripts'), { recursive: true });
  const script = join(source, 'scripts', 'calculate.py');
  const proof = randomBytes(12).toString('hex');
  const makeVersion = (version) => {
    writeFileSync(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: 读取本机订单，按版本规则生成计算结果。\n---\n使用此技能时，必须实际执行本技能 scripts/calculate.py。不要自己重写计算程序。脚本接受输入 JSON 路径和输出 JSON 路径两个参数。使用当前任务指定的输入输出。安装目录为 ${installed}。使用本机可用的 Python 解释器；只读取指定输入和本技能文件，只写指定输出。\n`,
    );
    writeFileSync(
      script,
      `import json, sys\nfrom pathlib import Path\ndata = json.loads(Path(sys.argv[1]).read_text())\nresult = {'total': sum(row['quantity'] * row['price'] for row in data['rows']) - data['fee'] * ${version}, 'version': ${version}, 'proof': '${proof}'}\nPath(sys.argv[2]).write_text(json.dumps(result))\nprint(json.dumps(result))\n`,
    );
  };
  const openCatalog = async () => page.getByRole('button', { name: '插件', exact: true }).click();
  const detail = async () =>
    page.getByRole('button', { name: `管理 · ${name}`, exact: true }).click();
  const beginInstall = async () => {
    await electronApp.evaluate((_electron, path) => {
      globalThis.__evoworkE2E.pickedDirectory = path;
    }, source);
    await page.getByRole('button', { name: '＋ 添加技能', exact: true }).click();
    await page.getByRole('menuitem', { name: '从目录安装', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '安装前请确认', exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const confirmInstall = async (dialog) => {
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '安装', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: `管理 · ${name}`, exact: true })).toBeVisible();
  };
  makeVersion(1);
  await openCatalog();
  const firstReview = await beginInstall();
  writeFileSync(script, 'raise RuntimeError("source changed after review")\n');
  await confirmInstall(firstReview);
  expect(readFileSync(join(installed, 'scripts', 'calculate.py'), 'utf8')).toContain(
    "'version': 1",
  );
  expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
  expect(realpathSync(legacy)).toBe(realpathSync(installed));
  await detail();
  await page.getByRole('button', { name: '设为仅手动调用', exact: true }).click();
  await expect(page.getByText('调用方式：仅手动调用', { exact: true })).toBeVisible();
  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(480, 900),
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(480);
  await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click();
  const toasts = page.getByRole('button', { name: '关闭提示', exact: true });
  while (await toasts.count()) await toasts.first().click();
  expect(
    await page
      .locator('.ew-catalog-detail')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('manual-skill-480.png') });
  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 900),
  );
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();

  const histories = [];
  for (const version of [1, 2]) {
    if (version === 2) {
      await openCatalog();
      makeVersion(2);
      await confirmInstall(await beginInstall());
      await detail();
      await expect(page.getByText('调用方式：仅手动调用', { exact: true })).toBeVisible();
    }
    const input = {
      rows: Array.from({ length: 5 }, () => ({
        quantity: randomInt(1, 9),
        price: randomInt(10, 90),
      })),
      fee: randomInt(3, 20),
    };
    const inputName = `input-${version}.json`;
    const outputName = `output-${version}.json`;
    writeFileSync(join(workspace, inputName), JSON.stringify(input));
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    await page.getByRole('button', { name: '选择项目' }).click();
    await page.getByRole('menuitem', { name: /^UI/ }).click();
    await page.getByLabel('需求输入').fill(`/${name}`);
    await page.getByRole('option', { name: new RegExp(name) }).click();
    await page
      .getByLabel('需求输入')
      .fill(
        `/${name} 请执行技能脚本，读取当前工作目录的 ${inputName}，生成 ${outputName}。完成后简短报告总数和版本。不要联网、读取环境变量或创建子任务。`,
      );
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect
      .poll(
        async () => {
          const approval = page.getByLabel('需要你确认').first();
          if (await approval.count()) {
            const text = await approval.innerText();
            expect(text).not.toMatch(/curl|wget|https?:\/\/|printenv/);
            await approval.getByRole('button', { name: '允许这一次', exact: true }).click();
          }
          return existsSync(join(workspace, outputName));
        },
        { timeout: 180_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 180_000,
    });
    expect(JSON.parse(readFileSync(join(workspace, outputName), 'utf8'))).toEqual({
      total:
        input.rows.reduce((sum, row) => sum + row.quantity * row.price, 0) - input.fee * version,
      version,
      proof,
    });
    const history = await page.evaluate(async () => {
      const { tasks } = await window.evowork.getStartup();
      const task = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return window.evowork.openTask({ threadId: task.id });
    });
    expect(history.turns.every((turn) => turn.status === 'completed')).toBe(true);
    expect(
      history.items.some(
        (item) =>
          item.type === 'commandExecution' && /python[\s\S]*calculate\.py/.test(item.command),
      ),
    ).toBe(true);
    histories.push(history);
  }
  await openCatalog();
  await detail();
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await expect(page.getByRole('button', { name: '启用', exact: true })).toBeVisible();
  const candidate = () =>
    page.evaluate(async () =>
      (await window.evowork.getComposerContext({ forceReload: true })).mentions.some(
        (entry) => entry.name === 'lifecycle-calculator',
      ),
    );
  expect(await candidate()).toBe(false);
  await page.getByRole('button', { name: '启用', exact: true }).click();
  await expect.poll(candidate).toBe(true);
  await page.getByRole('button', { name: '卸载', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '卸载', exact: true }).click();
  await expect.poll(candidate).toBe(false);
  expect(existsSync(installed)).toBe(false);
  expect(existsSync(legacy)).toBe(false);
  const wirePath = join(home, 'follow-up-wire.jsonl');
  const wire = () =>
    readFileSync(wirePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
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
      { timeout: 60_000 },
    )
    .toBe(0);
  const rows = wire();
  const requests = rows.filter((row) => row.type === 'request');
  const model = selectRealModel();
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.every(
      (row) =>
        row.model === model.upstreamModel && row.endpoint === model.baseUrl + '/chat/completions',
    ),
  ).toBe(true);
  expect(rows.filter((row) => row.type === 'response')).toHaveLength(requests.length);
  expect(rows.filter((row) => row.type === 'response').every((row) => row.status === 200)).toBe(
    true,
  );
  expect(rows.filter((row) => row.type === 'transport-error')).toEqual([]);
  const evidencePath = info.outputPath('evidence.json');
  writeFileSync(
    evidencePath,
    JSON.stringify(
      { model: model.upstreamModel, baseUrl: model.baseUrl, wire: rows, histories },
      null,
      2,
    ),
  );
  await info.attach('skill-lifecycle-evidence', {
    path: evidencePath,
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('uninstalled.png') });
});
