import { test as base } from './fixtures.mjs';

/** A completed parallel request can remove a card between discovery and click. */
export async function approveCommandOnce(page) {
  // Hold the discovered button rather than rebinding .first() to a different card.
  const locator = page.getByLabel('需要你确认').first();
  if (!(await locator.count())) return false;
  const button = locator.getByRole('button', { name: '允许这一次', exact: true });
  const allow = await button.elementHandle({ timeout: 1000 }).catch(() => null);
  if (!allow) {
    if (page.isClosed() || !(await locator.count()) || (await button.count())) return false;
    const text = await locator.innerText({ timeout: 500 }).catch(() => null);
    if (text && !(await button.count())) throw new Error(`遇到非命令审批卡：${text}`);
    return false;
  }
  try {
    await allow.click({ timeout: 1000 });
    return true;
  } catch (error) {
    if (page.isClosed()) return false;
    const connected = await allow.evaluate((node) => node.isConnected).catch(() => false);
    if (!connected) return false;
    throw error;
  } finally {
    await allow.dispose();
  }
}

/** Drive the existing approval UI for cases that authorize all task commands.
 * Keep this opt-in: rejection, egress and overwrite-policy cases own their decisions.
 */
export function startCommandApprovals(getPage) {
  let stopped = false;
  let approved = 0;
  const pump = (async () => {
    while (!stopped) {
      const page = getPage();
      if (page && !page.isClosed()) {
        try {
          if (await approveCommandOnce(page)) approved++;
        } catch (error) {
          // Restart journeys can close the window during the initial card lookup.
          if (!page.isClosed()) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })();
  // Keep a rejected pump observed until teardown reports its original error.
  pump.catch(() => undefined);
  return async () => {
    stopped = true;
    await pump;
    return approved;
  };
}

export const test = base.extend({
  commandApprovals: [
    async ({ page }, use, info) => {
      const stop = startCommandApprovals(() => page);
      try {
        await use();
      } finally {
        const approved = await stop();
        await info.attach('command-approvals', {
          body: JSON.stringify({ approved }),
          contentType: 'application/json',
        });
      }
    },
    { auto: true },
  ],
});
