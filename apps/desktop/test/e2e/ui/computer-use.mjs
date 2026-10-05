/**
 * 电脑操控两份 spec 共用的界面动作与读数（`computer-use.spec.mjs` · `computer-use.real.spec.mjs`）。
 * 不叫 `*.spec.mjs`，所以 Playwright 不把它当用例收。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ELEMENT } from '../harness/fake-computer-use.mjs';
import { expect } from './fixtures.mjs';

/* 应用 id 只有一份：假 Helper 那边列出的就是这几个（那个模块不碰 electron，spec 这一侧也能 import） */
export { SYSTEM_SETTINGS, TERMINAL, TEXTEDIT } from '../harness/fake-computer-use.mjs';
/** 假 TextEdit 里「正文」框的元素编号 */
export const BODY_ELEMENT = ELEMENT.body;
/** 12 §5.1 的九个写动作 */
export const WRITE_TOOLS = Object.freeze([
  'click',
  'drag',
  'paste',
  'perform_secondary_action',
  'press_key',
  'scroll',
  'select_text',
  'set_value',
  'type_text',
]);

/** 设置 → 安全与权限，交回「电脑操控」那一节 */
export async function openComputerUseSettings(page) {
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page
    .getByRole('menu', { name: '用户菜单' })
    .getByRole('menuitem', { name: '设置' })
    .click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '安全与权限', exact: true })
    .click();
  return page.locator('section.ew-settings-section').filter({ hasText: '电脑操控' });
}

export async function backToComposer(page) {
  await page.getByRole('button', { name: '新建任务' }).first().click();
  await expect(page.getByLabel('需求输入')).toBeVisible();
}

export function e2eHome(electronApp) {
  return electronApp.evaluate(() => globalThis.__evoworkE2E.home);
}

/** 宿主写给内核的 `[mcp_servers.cua_repl]` 一节（没有就是 undefined） */
export async function cuaConfigSection(electronApp) {
  const path = join(await e2eHome(electronApp), '.evowork', 'kernel', 'config.toml');
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('[mcp_servers.cua_repl]');
  if (start < 0) return undefined;
  const next = text.slice(start + 1).search(/^\[/m);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

/** 假 Helper 被宿主调过的每一个原生方法（含参数） */
export function helperCalls(electronApp) {
  return electronApp.evaluate(() => [...globalThis.__evoworkE2E.computerUse.calls]);
}

/** 假 TextEdit 现在的正文、有没有被保存过 */
export function fakeDocument(electronApp) {
  return electronApp.evaluate(() => ({
    body: globalThis.__evoworkE2E.computerUse.document(),
    saved: globalThis.__evoworkE2E.computerUse.saved(),
  }));
}

/** 打开电脑操控，并核对**三处**都真的打开了：设置页文案、按钮、内核配置 */
export async function enableComputerUse(page, electronApp) {
  const section = await openComputerUseSettings(page);
  await section.getByRole('button', { name: '启用电脑操控' }).click();
  await expect(section.getByRole('status')).toHaveText(
    '已启用；每个任务仍需确认内容传输和应用准入。',
  );
  await expect(section.getByRole('button', { name: '关闭电脑操控' })).toBeVisible();
  // 「启用后供下一条任务加载」：内核那边要真的被打开，否则下一条任务拿不到工具
  expect(await cuaConfigSection(electronApp)).toMatch(/^enabled = true$/m);
  await backToComposer(page);
}

/** 把折起来的过程组与每一条电脑操控记录都展开（展开只露出摘要文案，保存内容另要一次点击） */
export async function expandComputerUseItems(page) {
  const groups = page.locator('.ew-process-summary[aria-expanded="false"]');
  for (let guard = 0; guard < 30 && (await groups.count()) > 0; guard += 1) {
    await groups.first().click();
  }
  const summaries = page
    .locator('.ew-item[data-kind="mcpToolCall"]')
    .filter({ hasText: '电脑操控 ·' })
    .locator('.ew-item-summary[aria-expanded="false"]');
  for (let guard = 0; guard < 30 && (await summaries.count()) > 0; guard += 1) {
    await summaries.first().click();
  }
}

export async function send(page, text) {
  await page.getByLabel('需求输入').fill(text);
  await page.getByRole('button', { name: '发送' }).click();
}
