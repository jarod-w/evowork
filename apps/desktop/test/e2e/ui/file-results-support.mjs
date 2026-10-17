import { expect } from './fixtures.mjs';

export const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export const idle = (page) =>
  expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
export async function taskId(page, marker) {
  const tasks = (await page.evaluate(() => window.evowork.getStartup())).tasks;
  const task =
    tasks.find((t) => t.title === marker) ??
    [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  expect(task).toBeTruthy();
  return task.id;
}
export const results = (page, id) =>
  page.evaluate((threadId) => window.evowork.getTaskResults({ threadId }), id);
export async function settle(page, answer, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const approval = page.getByLabel('需要你确认');
    if (await approval.count()) {
      const allow = approval.first().getByRole('button', { name: '允许这一次', exact: true });
      if (!(await allow.count())) throw new Error('遇到预期工作区文件操作之外的确认');
      await allow.click();
    }
    if (await page.getByRole('alert', { name: '回合失败' }).count())
      throw new Error('回合失败，保留现场以核对原因');
    const replies = page.locator('.ew-item-agent').filter({ hasText: answer });
    if (
      (await replies.count()) &&
      (await page.getByLabel('输入区').getAttribute('data-run-state')) === 'idle'
    )
      return;
    await page.waitForTimeout(150);
  }
  throw new Error('文件任务未在规定时间内完成');
}
export async function selectTask(page, marker) {
  await page
    .getByRole('navigation', { name: '侧边栏' })
    .getByRole('button', { name: marker, exact: true })
    .click();
}
export async function changes(page) {
  if (await page.getByRole('button', { name: '打开结果', exact: true }).count())
    await page.getByRole('button', { name: '打开结果', exact: true }).click();
  await page.getByRole('tab', { name: '变更', exact: true }).click();
}
export async function revertSelected(page) {
  await page.getByRole('button', { name: '撤销这次变更', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
}

export async function scriptFileTools(electronApp, marker, steps, answer) {
  await electronApp.evaluate(
    (_, { marker, steps, answer }) => {
      const { gateway } = globalThis.__evoworkE2E;
      steps.forEach((step, index) =>
        gateway.scriptWhen(
          `${marker}-${index}`,
          (request) => request.text.includes(marker) && request.calls.length === index,
          {
            tool:
              step.tool === 'exec_command'
                ? 'exec_command'
                : (body) => {
                    const flatten = (list) =>
                      list.flatMap((entry) => (entry.tools ? flatten(entry.tools) : [entry.name]));
                    const name = flatten(JSON.parse(body).tools).find((name) =>
                      name?.endsWith(step.tool),
                    );
                    if (!name) throw new Error('文件 MCP 工具未注册：' + step.tool);
                    return name;
                  },
            args: step.args,
          },
        ),
      );
      gateway.scriptWhen(`${marker}-done`, (request) => request.text.includes(marker), {
        kind: 'text',
        text: answer,
      });
    },
    { marker, steps, answer },
  );
}

export async function expectFileAnswer(page, electronApp, answer) {
  try {
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
  } catch (error) {
    const trace = await electronApp.evaluate(() =>
      globalThis.__evoworkE2E.gateway.requestBodies.map((body) => {
        const value = JSON.parse(body);
        const flatten = (list) => list.flatMap((t) => (t.tools ? flatten(t.tools) : [t.name]));
        return {
          tools: flatten(value.tools ?? []),
          input: value.input?.filter((i) => i.type?.includes('function_call')),
        };
      }),
    );
    throw new Error(error.message + '\n工具请求：' + JSON.stringify(trace));
  }
}
