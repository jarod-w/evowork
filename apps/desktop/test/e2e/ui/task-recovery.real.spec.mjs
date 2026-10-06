/** 真模型验证恢复指令会检查磁盘进度；不代替确定性的崩溃/审批时序测试。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

test.use({ registerModels: true, hostGateway: true });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

test('真模型：崩溃后核对已写文件，完成剩余步骤且不重复第一阶段', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const saved = join(workspace, 'phase-one.txt');
  const result = join(workspace, 'phase-two.txt');
  const cmd = `printf 'saved-once\n' >> ${quote(saved)}; sleep 45; printf 'remaining-done\n' > ${quote(result)}`;
  await startTaskInWorkspace(
    page,
    electronApp,
    `这是一个两阶段恢复验收任务。第一阶段保存检查点，第二阶段生成结果。请在 exec_command 中执行以下单条命令：\n${cmd}\n如果我中途停止或执行内核中断，恢复时先检查两个文件。已经完成的阶段不能重复写入；恢复时不必再次等待，只完成未完成的阶段。不要修改其它文件。`,
  );
  await expect
    .poll(() => (existsSync(saved) ? readFileSync(saved, 'utf8') : ''), { timeout: 120_000 })
    .toBe('saved-once\n');
  expect(existsSync(result)).toBe(false);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
  await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: '继续任务' })).toBeEnabled();
  expect(readFileSync(saved, 'utf8')).toBe('saved-once\n');
  await page.getByRole('button', { name: '继续任务' }).click();
  await expect
    .poll(() => (existsSync(result) ? readFileSync(result, 'utf8') : ''), { timeout: 150_000 })
    .toBe('remaining-done\n');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 120_000,
  });
  expect(readFileSync(saved, 'utf8')).toBe('saved-once\n');
  await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
});
