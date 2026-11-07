import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './fixtures.mjs';
test('发货策略 hook 均由原生发现并受信任，不能静默失效', async ({ page, electronApp }, info) => {
  await expect(page.getByLabel('需求输入')).toBeVisible();
  const manifest = JSON.parse(
    readFileSync(resolve('plugins/hooks/evowork-policy/hooks.json'), 'utf8'),
  );
  const expected = Object.values(manifest.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks),
  ).length;
  const actual = await electronApp.evaluate(() => globalThis.__evoworkE2E.inspectHooks());
  await info.attach('public-hook-discovery', {
    body: JSON.stringify(actual, null, 2),
    contentType: 'application/json',
  });
  expect(actual.activeBundledCount).toBe(expected);
  const hooks = actual.groups.flatMap((group) => group.hooks);
  expect(
    hooks.filter(
      (hook) => hook.enabled !== false && ['trusted', 'managed'].includes(hook.trustStatus),
    ).length,
  ).toBeGreaterThanOrEqual(expected);
});
