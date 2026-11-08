/** Actual provider, shipped browser MCP and Chrome; the page value is never in the prompt. */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { selectRealModel } from '../harness/real-models.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: { EVOWORK_UI_FOLLOW_UP_WIRE: '1' },
});

test('真模型浏览器：授权前零读取，真实 Chrome 取回未知口令并保留来源引用', async ({
  page,
  electronApp,
}, info) => {
  test.setTimeout(240000);
  const marker = 'BROWSER-' + randomBytes(10).toString('hex');
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url !== '/report') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<title>浏览器验收报告</title><main><h1>本机验收报告</h1><p>验收口令：' +
        marker +
        '</p><p>' +
        '这是本机生成的待核对报告，仅阅读正文并引用来源。'.repeat(15) +
        '</p></main>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/report';
  try {
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await page.getByRole('tab', { name: '连接器', exact: true }).click();
    await page
      .locator('.ew-projects-grid')
      .getByRole('button', { name: /^浏览器 / })
      .click();
    await page.getByRole('button', { name: '信任并启用', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: '信任「浏览器」' })
      .getByRole('button', { name: '信任并启用' })
      .click();
    await expect(page.getByRole('button', { name: '信任并启用', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
    await startTaskInWorkspace(
      page,
      electronApp,
      '仅使用已启用的 browser 浏览器连接器读取 ' +
        url +
        '。提取网页正文中的验收口令，完整逐字输出口令，并按工具返回的 source.id 添加 [[cite:来源ID]] 来源引用。不要猜测口令；不要用终端、Python 或其他方式联网；不要写文件、访问其他 URL 或派生子任务。',
    );
    const origin = page.getByRole('alertdialog').filter({ hasText: '允许读取和操作网站' });
    // 来源确认卡的无障碍名称也是「需要你确认」，必须先排除，避免把它当成连接器审批。
    const approval = page.getByLabel('需要你确认').filter({ hasNotText: '允许读取和操作网站' });
    await expect
      .poll(async () => (await approval.count()) > 0 || (await origin.count()) > 0, {
        timeout: 90000,
      })
      .toBe(true);
    if (await approval.count()) {
      await expect(approval).toContainText(/browser|浏览器/i);
      expect(requests).toBe(0);
      await approval.getByRole('button', { name: '允许这一次', exact: true }).click();
    }
    await expect(origin).toBeVisible({ timeout: 90000 });
    await expect(origin).toContainText('http://127.0.0.1:' + server.address().port);
    expect(requests, '本次来源授权之前已经读取页面').toBe(0);
    await origin.getByRole('button', { name: '确认本次动作', exact: true }).click();
    await expect(page.getByRole('main', { name: '对话区' })).toContainText(marker, {
      timeout: 90000,
    });
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect(page.locator('.ew-web-citation').first()).toHaveAttribute('href', url);
    const tasks = (await page.evaluate(() => window.evowork.getStartup())).tasks;
    const task = tasks.find((entry) => entry.title.includes('仅使用已启用的')) ?? tasks[0];
    const selected = selectRealModel();
    expect([selected.id, 'evowork/' + selected.upstreamModel]).toContain(task.modelId);
    await expect
      .poll(
        async () => {
          const history = await page.evaluate(
            (threadId) => window.evowork.openTask({ threadId }),
            task.id,
          );
          return (
            history.turns.length > 0 && history.turns.every((turn) => turn.status === 'completed')
          );
        },
        { timeout: 60000 },
      )
      .toBe(true);
    const history = await page.evaluate(
      (threadId) => window.evowork.openTask({ threadId }),
      task.id,
    );
    const reads = history.items.filter(
      (item) => item.type === 'mcpToolCall' && item.tool.endsWith('browser_read_page'),
    );
    expect(reads.some((item) => item.status === 'completed')).toBe(true);
    expect(history.items.filter((item) => item.type === 'commandExecution')).toHaveLength(0);
    await page.reload();
    await page.getByRole('button', { name: task.title, exact: true }).click();
    await expect(page.getByRole('main', { name: '对话区' })).toContainText(marker);
    await expect(page.locator('.ew-web-citation').first()).toHaveAttribute('href', url);
    const home = await electronApp.evaluate(() => globalThis.__evoworkE2E.home);
    const wirePath = join(home, 'follow-up-wire.jsonl');
    const wire = existsSync(wirePath)
      ? readFileSync(wirePath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const model = selectRealModel();
    expect(wire.filter((row) => row.type === 'request').length).toBeGreaterThan(0);
    expect(
      wire
        .filter((row) => row.type === 'request')
        .every(
          (row) =>
            row.model === model.upstreamModel &&
            row.endpoint === model.baseUrl + '/chat/completions',
        ),
    ).toBe(true);
    const evidence = JSON.stringify({ url, marker, requests, task, history, wire }, null, 2);
    if (process.env.EVOWORK_UI_MODEL_KEY && evidence.includes(process.env.EVOWORK_UI_MODEL_KEY))
      throw new Error('凭据命中，拒绝保存证据');
    await info.attach('real-browser-evidence', { body: evidence, contentType: 'application/json' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
