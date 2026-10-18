import { expect, test } from './fixtures.mjs';

test.use({ registerModels: true, hostGateway: true });

test('真实模型：运行中的思考预览自动换行，展开与窄窗口均不横向溢出', async ({
  page,
  electronApp,
}, testInfo) => {
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(960, 760);
  });
  await page
    .getByLabel('需求输入')
    .fill(
      '请设计一个完整的仓库库存核对方案：有三座仓库、每天两次盘点、跨仓调拨在途、退货待检、' +
        '重复扫码、离线补传和月底结账。给出至少八条互不重复的异常规则及各自的处理办法，' +
        '再用一组具体数字检验调拨和退货是否重复计入。只分析并回答，不使用工具或修改文件。' +
        '最终答复限制在300字以内，每条规则用一句话简要说明。',
    );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const preview = page.locator('.ew-reasoning-preview').first();
  await expect
    .poll(async () => (await preview.textContent().catch(() => ''))?.length ?? 0, {
      timeout: 120_000,
    })
    .toBeGreaterThanOrEqual(160);
  await expect(preview).toBeVisible();
  const layout = await preview.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()];
    return {
      lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  await testInfo.attach('running-layout', {
    body: JSON.stringify(layout),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('running-wrap.png') });
  expect(layout.lines, '长思考预览应显示为多行').toBeGreaterThan(1);
  expect(layout.scrollWidth, '思考预览应在消息列内换行').toBeLessThanOrEqual(layout.width + 1);
  await page.locator('.ew-reasoning').first().getByRole('button').click();
  const body = page.locator('.ew-reasoning-body').first();
  await expect(body).toBeVisible();
  await expect(preview).toBeHidden();
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('expanded-wrap.png') });
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 150_000,
  });
  await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
  await expect(page.locator('.ew-item-agent')).not.toBeEmpty();
  await expect(page.locator('.ew-reasoning-preview')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('completed.png') });
});
