/**
 * **策略 hook 真的在内核里跑** —— 2026-09-28 之前它从没被加载过。
 *
 * 策略包（`services/policy` + `plugins/hooks/evowork-policy`）写好、测好、打进了安装包，
 * 但内核只从托管 requirements / 配置层 / 已装插件里找 hook，三处都没有它：
 * 本机 `audit_log` 一行都没有，10 §2.3 的硬拦截一次都没生效过，
 * 完全访问的确认框却一直写着「完全访问也不能绕过」。
 *
 * 所以这里的断言只认**真内核**的后果：命令没执行（磁盘上没有它本该写的文件）、
 * 审计表里有那条拦截。单测证明的是决策对，证明不了它被调用过 —— 那正是这次的缺陷。
 *
 * **不碰真实凭据**：E2E 的内核继承真实 HOME，所以目标是 `~/.ssh` 下一个不存在的文件。
 * 拦住了，命令根本不跑；万一没拦住，`cat` 只会报"没有这个文件"。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

async function runCommand(page, electronApp, cmd, nth) {
  /*
   * **按内容认领，不按到达顺序**（2026-10-22 改）。原先用 `scriptNext`：内核在回合之前还会发
   * 别的请求（记忆、下一步建议），剧本被它们领走，回合拿到的只是一句文字回复、命令根本没发出去 ——
   * 「普通命令照常执行」因此红，而「~/.ssh 被拦」那条判的是「文件不存在」，**空心通过**。
   * 写法同 destructive-approval.spec。
   */
  const marker = `HOOK-E2E-${nth}-${Math.random().toString(36).slice(2, 8)}`;
  await electronApp.evaluate(
    (_electron, { marker, cmd }) =>
      globalThis.__evoworkE2E.gateway.scriptWhen(
        marker,
        (request) => request.text.includes(marker),
        { tool: 'exec_command', args: { cmd } },
      ),
    { marker, cmd },
  );
  // 第一条开新任务，要开在用例的工作区里（见 `startTaskInWorkspace`）；之后是同一任务里的追加
  if (nth === 0) await startTaskInWorkspace(page, electronApp, `${marker} 执行 ${cmd}`);
  else {
    await page.getByLabel('需求输入').fill(`${marker} 执行 ${cmd}`);
    await page.getByRole('button', { name: '发送' }).click();
  }
  await expect(page.getByText('E2E response').nth(nth)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 60_000,
  });
}

async function audit(page) {
  return (await page.evaluate(() => window.evowork.getAudit())).records;
}

test('读 ~/.ssh 的命令在执行前被拦下，并留下审计', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const ran = join(workspace, 'ran-after-ssh-read.txt');

  await runCommand(
    page,
    electronApp,
    `cat ~/.ssh/evowork-e2e-canary-absent; printf RAN > ${JSON.stringify(ran)}`,
    0,
  );

  // 整条命令没有执行：hook 在工具调用之前就拒掉了
  expect(existsSync(ran), 'hook 没拦住：命令执行了').toBe(false);
  /*
   * 审计表没有 action 列（`createAuditRepo` 的注释：分类值落在 tool_name 上，有工具名时
   * 被工具名覆盖），所以「这是一次拦截」要从 pathKind 与摘要认 —— 那是这条管道现在
   * 实际保留下来的东西。action 列的缺失记在 status.md 的后续项里。
   */
  const isBlock = (r) => r.pathKind === 'credentials' && /已阻止/.test(r.actionSummary ?? '');
  await expect.poll(async () => (await audit(page)).some(isBlock), { timeout: 15_000 }).toBe(true);
  const blocked = (await audit(page)).find(isBlock);
  expect(blocked?.toolName).toBe('Bash');
  // 审计里是摘要，不是路径本身（10 §6）
  expect(JSON.stringify(blocked)).not.toContain('.ssh');
});

test('普通命令照常执行 —— 包括以系统目录里的程序开头的那种', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const ok = join(workspace, 'ok.txt');

  await runCommand(page, electronApp, `/usr/bin/env printf OK > ${JSON.stringify(ok)}`, 0);

  expect(existsSync(ok) ? readFileSync(ok, 'utf8') : null).toBe('OK');
  // PreToolUse 与 PostToolUse 真的跑过：它们各为这条命令写一条，摘要是命令本身
  await expect
    .poll(
      async () =>
        (await audit(page)).filter(
          (r) => r.toolName === 'Bash' && (r.actionSummary ?? '').includes('printf OK'),
        ).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(1);
  expect((await audit(page)).some((r) => r.pathKind !== undefined)).toBe(false);
});

/*
 * 内核目录的两处放行口子（2026-10-22，10 §2.3）。E2E 的内核与 hook 都以测试自己的临时 HOME 运行，
 * 所以 `~/.evowork/kernel/` 就是这个用例的临时内核目录 —— 判的是真规则，碰不到真实数据。
 * 目标文件都不存在：放行时 `cat` 只报「没有这个文件」，后面的 printf 照跑；拦下时整条不执行。
 */
test('内核技能与记忆目录读得到，内核配置照拦 —— 内核亲口指给模型的路径不能被自己的策略挡住', async ({
  page,
  electronApp,
}) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const marker = (name) => join(workspace, name);

  await runCommand(
    page,
    electronApp,
    `cat ~/.evowork/kernel/skills/e2e-absent/reference/guide.md; printf RAN > ${JSON.stringify(marker('ran-skill-read.txt'))}`,
    0,
  );
  await runCommand(
    page,
    electronApp,
    // eslint-disable-next-line @evowork/no-kernel-internals -- 这是交给假模型去执行的命令，测试本身不读写该目录
    `ls ~/.evowork/kernel/memories/; printf RAN > ${JSON.stringify(marker('ran-memories-read.txt'))}`,
    1,
  );
  await runCommand(
    page,
    electronApp,
    `cat ~/.evowork/kernel/config-e2e-absent.toml; printf RAN > ${JSON.stringify(marker('ran-config-read.txt'))}`,
    2,
  );

  expect(existsSync(marker('ran-skill-read.txt')), '读技能参考文件被拦了').toBe(true);
  expect(existsSync(marker('ran-memories-read.txt')), '读记忆目录被拦了').toBe(true);
  expect(existsSync(marker('ran-config-read.txt')), '读内核配置没拦住').toBe(false);
  const isSelfBlock = (r) => r.pathKind === 'evowork-self' && /已阻止/.test(r.actionSummary ?? '');
  await expect
    .poll(async () => (await audit(page)).filter(isSelfBlock).length, { timeout: 15_000 })
    .toBe(1);
});
