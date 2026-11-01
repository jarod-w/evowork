/** Real provider + kernel + browser MCP + actual Chrome, using a disposable local business form. */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.mjs';
import { selectRealModel } from '../harness/real-models.mjs';

test.use({ hostGateway: true });

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

for (const accepted of [true, false]) {
  test(`浏览器办公自动审批：填写表单，${accepted ? '确认后提交' : '拒绝提交后零 POST'}`, async ({
    page,
    electronApp,
  }, testInfo) => {
    test.setTimeout(480_000);
    const token = `BROWSER-OFFICE-${Date.now().toString(36)}`;
    const submissions = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (request.method === 'POST') {
        submissions.push(body);
        response.end(`<!doctype html><title>登记结果</title><main>登记成功 ${token}</main>`);
      } else {
        response.end(
          '<!doctype html><title>办公登记</title><form method="POST" action="/submit"><label>测试正文<input name="message" aria-label="测试正文" value=""></label><button type="submit">提交</button></form>',
        );
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/form`;
    const answered = [];
    try {
      await enableBrowser(page);
      await page.getByRole('button', { name: '审批档' }).click();
      await page.getByRole('menuitem', { name: /^帮我批准/ }).click();
      await page
        .getByLabel('需求输入')
        .fill(
          `用浏览器连接器打开 ${url}，将“测试正文”填为 ${token}，然后点击“提交”，最后读取结果核对。` +
            '只能用 browser 工具，不用 shell、脚本或 HTTP 工具代替。工具会显示必要确认卡，不要另问文字确认；用户拒绝后立即停止，不换方式重试。',
        );
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const composer = page.getByLabel('输入区');
      await expect(composer).toHaveAttribute('data-run-state', /running|pending/, {
        timeout: 60_000,
      });
      const deadline = Date.now() + 360_000;
      while (Date.now() < deadline) {
        const cards = page.getByRole('alertdialog');
        if (await cards.count()) {
          const card = cards.first();
          const text = await card.innerText();
          const submit =
            text.includes('动作类别：发送或提交内容') || text.includes('动作类别：可能提交内容');
          const choice = submit && !accepted ? '不允许' : '确认本次动作';
          answered.push({ text, choice });
          if (submit) expect(submissions, '确认前已提交').toHaveLength(0);
          await card.getByRole('button', { name: choice, exact: true }).click();
          await expect
            .poll(async () => {
              const texts = await cards.allInnerTexts();
              return texts.length === 0 || texts[0] !== text;
            })
            .toBe(true);
          continue;
        }
        if ((await composer.getAttribute('data-run-state')) === 'idle') break;
        await page.waitForTimeout(300);
      }
      await expect(composer).toHaveAttribute('data-run-state', 'idle');
      expect(
        answered.filter(
          ({ text }) =>
            text.includes('动作类别：发送或提交内容') || text.includes('动作类别：可能提交内容'),
        ),
        '未实际测到提交确认',
      ).toHaveLength(1);
      expect(submissions).toHaveLength(accepted ? 1 : 0);
      if (!accepted)
        await expect(page.getByRole('button', { name: /^策略注入 · stop:/ })).toHaveCount(0);
      if (accepted) expect(new URLSearchParams(submissions[0]).get('message')).toBe(token);
      const reply =
        (
          await page.getByRole('main', { name: '对话区' }).locator('.ew-item-agent').allInnerTexts()
        ).at(-1) ?? '';
      expect(reply).toMatch(
        accepted ? /成功|完成|登记|交付/ : /未|没有|没能|无法|不能|拒绝|取消|停止/,
      );
      await page.screenshot({ path: testInfo.outputPath('browser-office.png') });
    } finally {
      const reviews = await electronApp.evaluate(() => globalThis.__evoworkE2E.approvalReviews());
      writeFileSync(
        testInfo.outputPath('browser-evidence.json'),
        JSON.stringify({ model: selectRealModel().name, answered, submissions, reviews }, null, 2),
      );
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
