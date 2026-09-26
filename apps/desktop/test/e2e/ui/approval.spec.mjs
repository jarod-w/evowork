/**
 * **第二条真交互旅程：用户点「允许这一次」，那条命令真的跑了。**
 *
 * 审批卡是这个产品里**后果最重的一下点击** —— 用户凭卡片上那几行字决定要不要放行一次
 * 越过沙箱的操作。它此前的验证都停在协议层：断言型 E2E 经 preload 桥调
 * `decideApproval({ decision: 'accept' })`，jsdom 组件测试渲染一张假卡片。
 * 两者都没回答用户真正关心的那个问题：**我在屏幕上按下的那个按钮，真的让它执行了吗。**
 *
 * 所以这条的断言落在磁盘上，不落在"回复发出去了"：内核对形状不对的审批回复
 * **不报错**（`unwrap_or_else` 兜一个默认值），界面上"允许"和"拒绝"会长得一模一样。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './fixtures.mjs';

test('审批卡：点允许之后，命令真的执行了', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  expect(workspace, '控制面里没有 workspace').toBeTruthy();
  const approvedFile = join(workspace, 'approved-by-ui.txt');
  expect(existsSync(approvedFile), '这个文件应该还不存在').toBe(false);

  /*
   * 触发器是确定性的：`sandbox_permissions: 'require_escalated'` 就是模型在说
   * "我要越过沙箱"，内核在 on-request 档下**必须**问用户。
   * 不用 turnMarker：那会让假网关扣住回合，而这里需要它走完。
   */
  await electronApp.evaluate(
    (_electron, script) => {
      globalThis.__evoworkE2E.gateway.scriptNext(script);
    },
    {
      tool: 'exec_command',
      args: {
        cmd: `printf EVOWORK-UI-APPROVED > ${JSON.stringify(approvedFile)}`,
        sandbox_permissions: 'require_escalated',
        justification: '真交互测试：验证点了允许之后命令真的会执行',
      },
    },
  );

  await page.getByLabel('需求输入').fill('写一个需要我批准的文件');
  await page.getByRole('button', { name: '发送' }).click();

  // ① 卡片真的弹出来了（on-request 档生效 + 审批请求到了渲染层）
  const card = page.getByLabel('需要你确认');
  await expect(card).toBeVisible();

  /*
   * ② **卡片上要说清为什么。** 10 §3.2 把"原因"定为必填，缺失时组件会显式写
   * "执行内核没有给出理由"。看到那句兜底文案就说明理由真的丢了 ——
   * 而用户正是靠这句话决定点不点允许的，留空就是"让用户瞎点"的开始。
   */
  await expect(card).toContainText('原因');
  await expect(card).not.toContainText('执行内核没有给出理由');

  // ③ 展开技术详情，用户能看见到底要执行什么（看不见就是在盲签）
  await card.getByRole('button', { name: '查看技术详情' }).click();
  await expect(card).toContainText('EVOWORK-UI-APPROVED');

  /*
   * ④ **点默认按钮**，不是"本次任务内都允许"。
   * 10 §3.4 要范围最小化，而默认按钮是用户最可能点的那个 —— 要测就测它。
   */
  await card.getByRole('button', { name: '允许这一次' }).click();

  /*
   * ⑤ **落到磁盘上才算数。**
   *
   * 这一条是整条旅程唯一不能被"看起来对"蒙混过去的地方：回复形状不对时内核
   * 静默兜底，界面上什么都不会变，而文件永远不会出现。
   */
  await expect
    .poll(() => (existsSync(approvedFile) ? readFileSync(approvedFile, 'utf8') : null), {
      timeout: 60_000,
    })
    .toBe('EVOWORK-UI-APPROVED');

  // ⑥ 批完卡片要消失：留在屏幕上的话用户会以为还欠一次确认
  await expect(card).toHaveCount(0);
});
