/**
 * **一次附五个文件，真模型答得出每个文件里的那一件事。**
 *
 * 假网关那条（`attachments.spec.mjs`）能证明请求里**装了**什么；证明不了模型**看见了**什么。
 * 抽图抽错、网关把图丢了、内核按模型能力把图剥掉 —— 这些都不报错，模型只是照着文字编。
 * 所以要问一个**只在像素里**的数：PPT 饼图里企业客户的 45%。
 * 幻灯片文字里另放了一个「提升到 50%」当干扰项，照文字答的模型会答错。
 *
 * 跑法：`EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:ui-real -- attachments`
 * （默认 DeepSeek Flash；要办公扩展的 python，见 `makeOfficeFixtures`）
 */
import { expect, makeOfficeFixtures, test } from './fixtures.mjs';

test('附上 docx / pptx / xlsx / csv / png 五个文件，一轮里逐个答对（含只在图里的数）', async ({
  page,
  electronApp,
}, testInfo) => {
  const fixtures = makeOfficeFixtures(testInfo.outputPath('picked'));
  await electronApp.evaluate(
    (_electron, files) => {
      globalThis.__evoworkE2E.pickedFiles = files;
    },
    fixtures.map((fixture) => fixture.path),
  );

  await page.getByRole('button', { name: '添加内容' }).click();
  await page.getByRole('menuitem', { name: /添加本地文件/ }).click();
  await expect(page.locator('.ew-attachment[data-state="ready"]')).toHaveCount(fixtures.length, {
    timeout: 60_000,
  });
  await expect(page.locator('.ew-attachment[data-state="failed"]')).toHaveCount(0);

  await page
    .getByLabel('需求输入')
    .fill(
      '我附上了五个文件。请逐条回答，每条一行，只写答案：\n' +
        '1. 销售报告里上半年销售额累计多少万元？\n' +
        '2. Q3 市场计划 PPT「客户结构」那页的饼图里，企业客户目前占比多少？（看图，不是目标值）\n' +
        '3. 市场预算表里 Q3 预算三项合计多少万元？\n' +
        '4. 渠道名单里有哪几个渠道？\n' +
        '5. 那张走势图里画了哪两条线？',
    );
  await page.getByRole('button', { name: '发送' }).click();

  const conversation = page.getByRole('main', { name: '对话区' });
  await expect(conversation).toBeVisible();
  // 先确认回合真的起来了：否则「已经是 idle」可能只是还没开始
  await expect(conversation.locator('.ew-item-agent').first()).toBeVisible({ timeout: 240_000 });
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 240_000,
  });
  /*
   * **只读模型的回答**，不读整个对话区。用户那条气泡里画着注入的附件说明
   * （「已上传《上半年销售报告.docx》…摘要：…累计 915 万元…」）——
   * 读整个对话区的话，模型一个字不答这条也是绿的。第一版就是这么写的。
   */
  const answer = (await conversation.locator('.ew-item-agent').allInnerTexts()).join('\n').trim();
  await testInfo.attach('模型的回答', { body: answer, contentType: 'text/plain' });
  expect(answer.length, '模型什么都没答').toBeGreaterThan(10);

  const missed = fixtures.filter((fixture) => !fixture.needle.test(answer));
  expect(
    missed.map((fixture) => `${fixture.what}（${fixture.file}）`),
    `模型没答出这些。完整回答：\n${answer}`,
  ).toEqual([]);
});
