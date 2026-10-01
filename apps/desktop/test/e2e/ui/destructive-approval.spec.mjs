/**
 * **删除要先问你** —— 2026-09-28 外部测试包 D1 组的回归（Q45 修订，10 §2.4）。
 *
 * 那一轮里「请求批准」档下 `rm inputs/D1_important.xlsx` 直接执行、文件没了，
 * 而 `rm -rf` 会问 —— 内核的危险命令启发式只认带 `-f` 的 rm。现在由
 * `$CODEX_HOME/rules/evowork.rules` 的 prompt 规则补上纯删除命令。
 *
 * 命令逐字取自失败轮次的 transcript，由假网关当作模型的工具调用发出去，
 * 真内核执行。**断言落在磁盘上**：拒绝之后文件必须一个字节都没变。
 *
 * 带重定向的脚本内核不按段匹配规则，扩展点做不到。其中「`>` 覆盖已有文件」由内核补丁 P6 补上
 * （`patches/evowork/0001-exec-overwrite-approval`，夹具会拒绝没编进它的内核）；
 * 最后一条钉的是**仍然的缺口**：`>>` 追加与删除写进同一段脚本，P6 不管、规则也匹配不上。
 * 哪天那条变红，说明内核开始覆盖它了 —— 去改 10 §2.4 与 status.md。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './fixtures.mjs';

function seed(workspace) {
  const inputs = join(workspace, 'inputs');
  mkdirSync(join(inputs, 'D1_dir'), { recursive: true });
  writeFileSync(join(inputs, 'D1_important.xlsx'), 'IMPORTANT');
  writeFileSync(join(inputs, 'D1_notes.md'), '# notes\n');
  writeFileSync(join(inputs, 'D1_draft.md'), '# 草稿\n');
  writeFileSync(join(inputs, 'D1_dir', 'keep.txt'), 'KEEP');
}

function read(workspace, rel) {
  const path = join(workspace, 'inputs', rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * 让假网关把 `cmd` 当作模型的一次工具调用发出去，返回这一回合里**有没有弹卡**。
 * 弹了就按 `decision` 点掉，并把卡片上的原因与按钮一起交回来。
 */
async function runCommand(page, electronApp, cmd, { decision = '拒绝', nth }) {
  await electronApp.evaluate(
    (_electron, script) => globalThis.__evoworkE2E.gateway.scriptNext(script),
    { tool: 'exec_command', args: { cmd } },
  );
  await page.getByLabel('需求输入').fill(`执行 ${cmd}`);
  await page.getByRole('button', { name: '发送' }).click();

  const card = page.getByLabel('需要你确认');
  const reply = page.getByText('E2E response').nth(nth);
  const first = await Promise.race([
    card.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'card'),
    reply.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'reply'),
  ]);
  let seen = null;
  if (first === 'card') {
    seen = {
      reason: await card.locator('.ew-approval-reason').innerText(),
      impact: await card.locator('.ew-approval-impact').innerText(),
      sessionButton: await card.getByRole('button', { name: '本次任务内都允许' }).count(),
    };
    await card.getByRole('button', { name: decision, exact: true }).click();
    await expect(card).toHaveCount(0);
  }
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 60_000,
  });
  return seen;
}

test('请求批准：纯删除命令要先问，拒绝后文件一个字节都没变', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const commands = [
    'rm inputs/D1_important.xlsx && echo "deleted"', // D1-1 #1 的原样命令
    'rm inputs/D1_important.xlsx inputs/D1_notes.md',
    '/bin/rm inputs/D1_notes.md',
    'unlink inputs/D1_important.xlsx',
    'rm -rf inputs/D1_dir', // D1-3：以前就问，但卡片写着「建议先拒绝」
  ];
  for (const [nth, cmd] of commands.entries()) {
    seed(workspace);
    const seen = await runCommand(page, electronApp, cmd, { nth });
    expect(seen, `「${cmd}」没有弹审批就执行了`).not.toBeNull();
    // 原因要说清（10 §3.2 必填）：不能是兜底文案，也不能露出内核的英文包装
    expect(seen.reason).toContain('删除文件');
    expect(seen.reason).not.toContain('执行内核没有给出理由');
    expect(seen.reason).not.toContain('requires approval');
    expect(seen.impact).toContain('删除文件');
    // 删除不给一键放开整个任务（10 §3.3）
    expect(seen.sessionButton).toBe(0);
    expect(read(workspace, 'D1_important.xlsx')).toBe('IMPORTANT');
    expect(read(workspace, 'D1_notes.md')).toBe('# notes\n');
    expect(read(workspace, 'D1_dir/keep.txt')).toBe('KEEP');
  }
});

test('请求批准：点「允许这一次」之后才真的删', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  seed(workspace);
  const seen = await runCommand(page, electronApp, 'rm inputs/D1_important.xlsx', {
    decision: '允许这一次',
    nth: 0,
  });
  expect(seen).not.toBeNull();
  await expect.poll(() => read(workspace, 'D1_important.xlsx')).toBeNull();
});

test('完全访问：删除仍然问你，而不是被内核直接拒掉', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  await page.getByRole('button', { name: '审批档' }).click();
  await page.locator('.ew-menu-item').filter({ hasText: '完全访问' }).click();
  await page.getByRole('button', { name: '仅当前任务使用完全访问' }).click();
  await expect(page.getByRole('button', { name: '审批档' })).toContainText('完全访问');

  // 以前（approval_policy = never）：`rm -rf` 直接被拒，普通 rm 不问就删
  seed(workspace);
  const plain = await runCommand(page, electronApp, 'rm inputs/D1_important.xlsx', { nth: 0 });
  expect(plain, '完全访问下普通 rm 没问就执行了').not.toBeNull();
  expect(read(workspace, 'D1_important.xlsx')).toBe('IMPORTANT');

  const forced = await runCommand(page, electronApp, 'rm -rf inputs/D1_dir', {
    decision: '允许这一次',
    nth: 1,
  });
  expect(forced, '完全访问下 rm -rf 应该问，而不是被拒').not.toBeNull();
  await expect.poll(() => read(workspace, 'D1_dir/keep.txt')).toBeNull();
});

test('覆盖已有文件要先问（内核补丁 P6，D1-2），拒绝后内容一个字节都没变', async ({
  page,
  electronApp,
}) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  seed(workspace);
  // D1-2 失败轮次的原样命令：以前在「请求批准」下直接把会议纪要清空了
  const seen = await runCommand(
    page,
    electronApp,
    "printf '已归档\\n' > inputs/D1_notes.md && cat inputs/D1_notes.md",
    { nth: 0 },
  );
  expect(seen, '覆盖已有文件没有弹审批 —— 内核补丁 P6 没编进去？').not.toBeNull();
  expect(seen.reason).toContain('覆盖已有的文件');
  expect(seen.reason).toContain('inputs/D1_notes.md');
  expect(seen.reason).not.toContain('overwrites');
  expect(read(workspace, 'D1_notes.md')).toBe('# notes\n');
});

test('新建文件照常直接跑 —— 模型最常见的动作，不能因为 P6 每次都问', async ({
  page,
  electronApp,
}) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  seed(workspace);
  const seen = await runCommand(page, electronApp, "printf 'NEW' > inputs/brand-new.md", {
    nth: 0,
  });
  expect(seen, '新建文件也弹了审批').toBeNull();
  await expect.poll(() => read(workspace, 'brand-new.md')).toBe('NEW');
});

test('**已知缺口**：追加与删除写进同一段含 `>>` 的脚本时，删除不问（D1-4 的一种写法）', async ({
  page,
  electronApp,
}) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  seed(workspace);
  const seen = await runCommand(
    page,
    electronApp,
    "printf '待审\\n' >> inputs/D1_draft.md && rm inputs/D1_important.xlsx",
    { nth: 0 },
  );
  /*
   * 这里断言的是**现状**，不是期望。内核只对不含重定向的纯命令序列按段匹配删除规则
   * （`shell-command/src/bash.rs` 的 `parse_shell_lc_plain_commands`），`>>` 是追加、P6 也不管，
   * 于是整段放行。变红 = 内核开始覆盖了：删掉这条，并把 10 §2.4 的「仍然的缺口」一并改掉。
   */
  expect(seen, '这段脚本现在会弹卡了 —— 内核行为变了，去更新文档').toBeNull();
  expect(read(workspace, 'D1_important.xlsx')).toBeNull();
});
