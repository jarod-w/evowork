/** 生产组件与 CSS 的真实 Electron 几何回归，不下载或安装用户技能。 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron, expect, test } from '@playwright/test';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../../../..');

test('长审计只滚正文，操作始终可见；卡片标签完整换行', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const folder = mkdtempSync(join(tmpdir(), 'evowork-skill-layout-'));
  testInfo.attach('fixture', {
    body: '生产组件 + 样式的隔离 Electron 布局测试',
    contentType: 'text/plain',
  });
  await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { TOKENS_CSS } from '@evowork/tokens';
      import { Dialog, ItemCard, PillButton } from './apps/desktop/src/renderer/components/primitives';
      import { TaskWorkspace } from './apps/desktop/src/renderer/views/task-workspace';
      import { SkillInstallDialog } from './apps/desktop/src/renderer/components/skill-install-dialog';
      import './apps/desktop/src/renderer/styles/app.css';
      const style = document.createElement('style'); style.textContent = TOKENS_CSS; document.head.append(style);
      function View() {
        const [open, setOpen] = useState(false);
        const [form, setForm] = useState(false);
        const findings = Array.from({ length: 150 }, (_, i) => 'scripts/vendor/websocket/file-' + i + '.py 会执行命令或脚本。');
        return <><ItemCard name="Kimi 演示文稿" description="自由排版创建和编辑演示文稿，本机导出可编辑 PPTX。" badges={['EvoWork 精选','新上架','未安装','需注意','1.2.0-evowork.1']} action={<PillButton variant="accent" onClick={() => setOpen(true)}>安装</PillButton>} />
        <PillButton onClick={() => setForm(true)}>长名称表单</PillButton>
        <TaskWorkspace title="布局核查" status="running" items={[]} pendingApprovals={[]} onDecide={() => {}} itemContext={{}} goal={{threadId:'layout', objective:'核对季度报告的内容与数据'.repeat(100),status:'active',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1}} />
        {form && <Dialog title={'连接器名称'.repeat(100)} confirmLabel="保存" closable onCancel={() => setForm(false)} onConfirm={() => setForm(false)}>{Array.from({length:30}, (_,i)=><label className="ew-dialog-field" key={i}>字段 {i}<input aria-label={'字段 '+i}/></label>)}</Dialog>}
        {open && <SkillInstallDialog audit={{skillId: 'open-kimi-ppt', level: 'p1', findings}} onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)} />}</>;
      }
      createRoot(document.getElementById('root')).render(<View />);
    `,
    },
    nodePaths: [join(root, 'apps/desktop/node_modules')],
    outfile: join(folder, 'view.js'),
    bundle: true,
    jsx: 'automatic',
    platform: 'browser',
  });
  writeFileSync(
    join(folder, 'view.html'),
    '<html><head><meta charset="utf-8"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>',
  );
  // Electron 内部 require('electron') 返回 API；Node 下该包返回可执行文件路径。
  writeFileSync(
    join(folder, 'main.cjs'),
    `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const win=new BrowserWindow({width:1200,height:760});win.loadFile(${JSON.stringify(join(folder, 'view.html'))});});`,
  );
  const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env;
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [join(folder, 'main.cjs')],
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Kimi 演示文稿')).toBeVisible();
    const tags = await page.locator('.ew-item-card-badge').evaluateAll((elements) =>
      elements.map((element) => ({
        text: element.textContent,
        nowrap: getComputedStyle(element).whiteSpace,
        clipped: element.scrollWidth > element.clientWidth,
      })),
    );
    expect(tags).toHaveLength(5);
    expect(tags.every((tag) => tag.nowrap === 'nowrap' && !tag.clipped)).toBe(true);
    await page.locator('.ew-item-card').screenshot({ path: testInfo.outputPath('card.png') });
    for (const width of [1200, 900, 480]) {
      await app.evaluate(
        ({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(value, 560),
        width,
      );
      const goalGeometry = await page
        .locator('.ew-goal-progress-copy')
        .first()
        .evaluate((copy) => {
          const objective = copy.querySelector('span[title]');
          const status = copy.querySelector('span + span');
          const statusRect = status.getBoundingClientRect();
          const objectiveRect = objective.getBoundingClientRect();
          return {
            statusFits: status.scrollWidth <= status.clientWidth,
            statusHeight: statusRect.height,
            lineHeight: parseFloat(getComputedStyle(status).lineHeight),
            objectiveHeight: objectiveRect.height,
            objectiveLineHeight: parseFloat(getComputedStyle(objective).lineHeight),
            separate: objectiveRect.right <= statusRect.left,
          };
        });
      expect(goalGeometry.statusFits).toBe(true);
      expect(goalGeometry.statusHeight).toBeLessThanOrEqual(goalGeometry.lineHeight + 1);
      expect(goalGeometry.objectiveHeight).toBeLessThanOrEqual(
        goalGeometry.objectiveLineHeight * 2 + 1,
      );
      expect(goalGeometry.separate).toBe(true);
    }
    await page.getByRole('button', { name: '安装', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByText('发现 150 项命令或脚本执行提示。')).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath('collapsed-dialog.png') });
    await page.getByText('查看完整审计明细（150 项）').click();
    for (const size of [
      { width: 1200, height: 760 },
      { width: 900, height: 560 },
      { width: 480, height: 560 },
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, dimensions) =>
          BrowserWindow.getAllWindows()[0].setSize(dimensions.width, dimensions.height),
        size,
      );
      const geometry = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const body = element.querySelector('.ew-dialog-body');
        const actions = element.querySelector('.ew-dialog-actions').getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: innerHeight,
          scrolls: body.scrollHeight > body.clientHeight,
          buttonsVisible: actions.top >= 0 && actions.bottom <= innerHeight,
        };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.scrolls).toBe(true);
      expect(geometry.buttonsVisible).toBe(true);
      await page.locator('.ew-dialog-body').evaluate((body) => {
        body.scrollTop = body.scrollHeight;
      });
      await expect(page.getByLabel('我已了解')).toBeVisible();
      await expect(page.getByRole('button', { name: '安装为全局技能' })).toBeInViewport();
    }
    await page.screenshot({ path: testInfo.outputPath('expanded-dialog.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: '长名称表单' }).click();
    const form = page.getByRole('dialog');
    await expect(form).toBeVisible();
    const formGeometry = await form.evaluate((element) => {
      const heading = element.querySelector('.ew-dialog-title');
      const body = element.querySelector('.ew-dialog-body');
      const action = element.querySelector('.ew-dialog-actions').getBoundingClientRect();
      return {
        titleHeight: heading.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(heading).lineHeight),
        scrolls: body.scrollHeight > body.clientHeight,
        actionVisible: action.bottom <= innerHeight,
      };
    });
    expect(formGeometry.titleHeight).toBeLessThanOrEqual(formGeometry.lineHeight * 2 + 1);
    expect(formGeometry.scrolls).toBe(true);
    expect(formGeometry.actionVisible).toBe(true);
    await page.locator('.ew-dialog-body').evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await expect(page.getByRole('textbox', { name: '字段 29', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
