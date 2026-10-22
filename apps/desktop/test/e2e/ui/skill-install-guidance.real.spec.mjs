/**
 * **用户在对话里说「把附件里的 SKILL 装到系统里」，agent 该指路，不该自己拷文件。**
 *
 * 2026-10-07、10-08 真实发生了三次：agent 不知道有「安装为全局技能」这个入口，每次都把 SKILL.md
 * 拷进当前任务的 `.agents/skills/`。没选项目的任务各用一个临时目录，别的任务看不到；用户随后问
 * 「为什么 `$` 找不到」，agent 又去逆向 App 包。修法是 Craft 指令里写明作用范围与入口（2026-10-22）。
 *
 * 同一条旅程顺带核对附件说明的口吻：旧版写成「不要让我把全文贴出来」，被本机记忆记成了用户偏好。
 *
 * 真模型是概率性的，一轮绿不代表稳定：`--repeat-each` 看比例。
 * 跑法：`EVOWORK_UI_MODEL_KEY=sk-... npx playwright test skill-install-guidance --project=real`
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './fixtures.mjs';

const SKILL_NAME = 'e2e-weekly-coach';
const SKILL_MD = `---
name: ${SKILL_NAME}
description: 把零散的工作记录整理成周报提纲。
---

# 周报教练

用户给出本周的工作记录时，按「完成 / 进行中 / 风险」三段整理成提纲。
`;

/** 测试 HOME 下所有叫这个技能名的目录 —— agent 拷到哪儿都算（工作区、~/.agents、~/.evowork…） */
function copiedSkillDirs(root, depth = 0) {
  if (depth > 7) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
    const path = join(root, entry.name);
    return entry.name === SKILL_NAME ? [path] : copiedSkillDirs(path, depth + 1);
  });
}

test('附上 SKILL.md 说「装到系统里」：指路到「安装为全局技能」，不自己拷文件', async ({
  page,
  electronApp,
}, testInfo) => {
  const picked = testInfo.outputPath('picked');
  mkdirSync(picked, { recursive: true });
  const skillPath = join(picked, 'SKILL.md');
  writeFileSync(skillPath, SKILL_MD);
  await electronApp.evaluate(
    (_electron, files) => {
      globalThis.__evoworkE2E.pickedFiles = files;
    },
    [skillPath],
  );

  await page.getByRole('button', { name: '添加内容' }).click();
  await page.getByRole('menuitem', { name: /添加本地文件/ }).click();
  await expect(page.locator('.ew-attachment[data-state="ready"]')).toHaveCount(1, {
    timeout: 60_000,
  });

  await page.getByLabel('需求输入').fill('把附件里的这个 SKILL 安装到系统中，以后的任务都要能用。');
  await page.getByRole('button', { name: '发送' }).click();

  const conversation = page.getByRole('main', { name: '对话区' });
  await expect(conversation.locator('.ew-item-agent').first()).toBeVisible({ timeout: 240_000 });
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 240_000,
  });

  // ① 附件说明：第三人称、首行标明出处（它就画在用户自己的气泡里）
  const bubble = (await conversation.locator('.ew-item-user').first().innerText()).trim();
  await testInfo.attach('用户气泡', { body: bubble, contentType: 'text/plain' });
  expect(bubble).toContain('【附件说明 · 由 EvoWork 自动生成');
  expect(bubble).not.toContain('不要让我把全文贴出来');

  // ② 磁盘：agent 没有把技能拷到任何地方去「模拟安装」
  const home = await electronApp.evaluate(() => globalThis.__evoworkE2E.home);
  const copies = copiedSkillDirs(home);
  expect(copies, `agent 自己拷出了技能目录：${copies.join('、')}`).toEqual([]);

  // ③ 回答：指到界面上的入口（只读模型的回答，不读整个对话区 —— 气泡里有附件说明）
  const answer = (await conversation.locator('.ew-item-agent').allInnerTexts()).join('\n').trim();
  await testInfo.attach('模型的回答', { body: answer, contentType: 'text/plain' });
  expect(answer, `回答没有指到安装入口。完整回答：\n${answer}`).toMatch(
    /安装为全局技能|从 SKILL\.md 文件安装/,
  );
});
