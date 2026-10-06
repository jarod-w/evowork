/** 真 Electron / 内核 / browser MCP / Chrome / 本机网页；模型响应可控，不依赖外站稳定性。 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

async function enableBrowser(page) {
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
  await page.getByRole('button', { name: '新建任务' }).first().click();
}

async function scriptRead(electronApp, marker, url, id) {
  await electronApp.evaluate(
    (_electron, { marker, url, id }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      gateway.scriptWhen(
        `${marker}-read`,
        (view) =>
          view.text.includes(marker) &&
          view.calls.length === 0 &&
          view.tools.some((tool) => tool.endsWith('browser_read_page')),
        {
          tool: (body) => {
            const flatten = (list) =>
              list.flatMap((entry) => (entry.tools ? flatten(entry.tools) : [entry.name]));
            return flatten(JSON.parse(body).tools).find((tool) =>
              tool?.endsWith('browser_read_page'),
            );
          },
          args: { url },
        },
      );
      gateway.scriptWhen(
        `${marker}-reply`,
        (view) => view.text.includes(marker) && view.calls.length === 1,
        { kind: 'text', text: `验收回答 ${marker}。[[cite:${id}]]` },
      );
    },
    { marker, url, id },
  );
}

for (const accepted of [true, false]) {
  test(`公开资料：${accepted ? '授权读取、引用点击与历史恢复' : '拒绝后零请求、编造引用不可点击'}`, async ({
    page,
    electronApp,
  }) => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<title>本机官方研究报告</title><main><h1>研究报告</h1><p>${'可核对的公开正文。'.repeat(20)}</p></main>`,
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/report`;
    const id = `web_${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
    const marker = `WEB-${accepted ? 'ACCEPT' : 'DENY'}-${Date.now()}`;
    try {
      await enableBrowser(page);
      await scriptRead(electronApp, marker, url, id);
      await startTaskInWorkspace(page, electronApp, `读取公开资料并给出来源 ${marker}`);
      const first = page.getByLabel('需要你确认');
      await expect(first).toBeVisible({ timeout: 90_000 });
      const native = first.getByRole('button', { name: '允许这一次', exact: true });
      if (await native.count()) await native.click();
      const origin = page.getByRole('alertdialog').filter({ hasText: '允许读取和操作网站' });
      await expect(origin).toBeVisible({ timeout: 90_000 });
      await expect(origin).toContainText(`http://127.0.0.1:${server.address().port}`);
      expect(requests, '授权之前就访问了页面').toBe(0);
      await origin
        .getByRole('button', { name: accepted ? '确认本次动作' : '不允许', exact: true })
        .click();
      await expect(page.getByText(`验收回答 ${marker}。`, { exact: false })).toBeVisible({
        timeout: 90_000,
      });
      await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
      if (!accepted) {
        expect(requests).toBe(0);
        await expect(page.locator('.ew-web-citation')).toHaveCount(0);
        await expect(page.getByText('[来源不可用]', { exact: true })).toBeVisible();
        return;
      }
      expect(requests).toBeGreaterThan(0);
      const citation = page.getByRole('link', { name: '[127.0.0.1]', exact: true });
      await expect(citation).toBeVisible();
      await citation.click();
      await expect
        .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.openedExternalUrls))
        .toEqual([url]);
      await page.getByRole('button', { name: '来源（1）', exact: true }).click();
      await expect(page.getByRole('link', { name: '本机官方研究报告' }).last()).toBeVisible();
      await expect(page.getByText(/已读取网页/).last()).toBeVisible();
      // 重新挂载 renderer，必须从真实内核历史还原来源，不能靠上次渲染内存。
      await page.reload();
      if (!(await citation.count())) {
        await page
          .getByRole('navigation', { name: '侧边栏' })
          .getByRole('button', { name: /^读取公开资料并给出来源 WEB-ACCEPT/ })
          .first()
          .click();
      }
      await expect(citation).toBeVisible({ timeout: 60_000 });
      await citation.click();
      await expect
        .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.openedExternalUrls))
        .toEqual([url, url]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
