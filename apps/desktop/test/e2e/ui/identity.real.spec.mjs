/**
 * **只有真模型答得出来的问题。**
 *
 * 假网关能把模型摆布成任何样子，唯独不能替它**说出我们没教过它的话**。
 * 而这个产品最要紧的一条对外承诺恰恰是这种形状：K5 —— 对外不得出现 Codex / OpenAI 品牌。
 *
 * 这不是假想的风险。2026-09-07 真实发生过：用户问「介绍一下自己」，回答是
 * 「我是运行在 **Codex CLI** 里的执行智能体…」—— 两层指令都生效了，
 * 而内核写死的那段身份在 base instructions 里，`developer_instructions` 只叠加、盖不住它
 * （F25）。修法是走 `thread/start.baseInstructions` 整段替换 + 关掉 `openai-docs` 系统技能。
 *
 * 那次是**用户发现的**。这条测试就是让它下次由机器发现。
 *
 * 跑法：`EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:ui-real`
 */
import { expect, test } from './fixtures.mjs';

/** K5 说的「对外可见字符串」里不许出现的东西 */
const FORBIDDEN = ['Codex', 'codex', 'OpenAI', 'openai', 'ChatGPT'];

async function ask(page, text) {
  await page.getByLabel('需求输入').fill(text);
  await page.getByRole('button', { name: '发送' }).click();
  const conversation = page.getByRole('main', { name: '对话区' });
  await expect(conversation).toBeVisible();
  // 等回合真的收尾：运行中读到的是半截话
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 240_000,
  });
  return (await conversation.innerText()).trim();
}

test('问「介绍一下自己」，回答里不许出现内核品牌（K5）', async ({ page }) => {
  const answer = await ask(page, '介绍一下自己');

  expect(answer.length, '模型什么都没答 —— 这条断言无从谈起').toBeGreaterThan(10);
  for (const word of FORBIDDEN) {
    expect(
      answer,
      `回答里出现了「${word}」。2026-09-07 就是这么被用户发现的 —— ` +
        '检查 `thread/start.baseInstructions` 是否还在整段替换，以及 `openai-docs` 技能是否还关着',
    ).not.toContain(word);
  }
});

test('问「你用的是什么模型」，同样不许说漏（这条比上一条更容易漏）', async ({ page }) => {
  /*
   * 单独一条，因为它走的是**另一条**泄漏路径：F25 修掉身份之后，
   * 「你是什么模型」曾经会去读 `openai-docs` 这个系统技能里的文档。
   * 两条一起钉住，才覆盖得了那次修复的两半。
   */
  const answer = await ask(page, '你用的是什么模型？简短回答。');
  expect(answer.length).toBeGreaterThan(5);
  for (const word of FORBIDDEN) {
    expect(answer, `回答里出现了「${word}」`).not.toContain(word);
  }
});
