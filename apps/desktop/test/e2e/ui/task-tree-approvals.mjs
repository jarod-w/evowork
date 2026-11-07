import { approveCommandOnce } from './command-approvals.mjs';

/** Opt-in UI driver for a test that authorizes every command in its task tree. */
export async function approveTaskTreeCommandOnce(page) {
  if (await approveCommandOnce(page)) return true;
  const task = await page.evaluate(async () => {
    const { tasks } = await window.evowork.getStartup();
    return tasks
      .filter((task) => !task.parentThreadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  });
  if (!task) return false;
  const children = await page.evaluate(
    (id) => window.evowork.listSubtasks({ threadId: id }),
    task.id,
  );
  const child = children.find((child) => child.status === 'pending');
  if (!child) return false;
  const trigger = page.getByRole('button', { name: /^子任务 \d+$/ });
  if (!(await trigger.count())) return false;
  await trigger.click({ timeout: 1000 });
  const drawer = page.getByRole('complementary', { name: '子任务详情' });
  const entry = drawer
    .getByRole('button')
    .filter({ has: page.getByText(child.title ?? '未命名子任务', { exact: true }) })
    .first();
  if (!(await entry.count())) return false;
  await entry.click({ timeout: 1000 });
  try {
    await page
      .getByLabel('需要你确认')
      .first()
      .waitFor({ state: 'visible', timeout: 1000 })
      .catch(() => undefined);
    return await approveCommandOnce(page);
  } finally {
    await page.getByRole('button', { name: '返回根任务', exact: true }).click({ timeout: 1000 });
  }
}
