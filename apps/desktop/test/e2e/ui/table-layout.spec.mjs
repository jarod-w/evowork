/** 生产表格、资料库与 CSS 的真实窗口回归；不读取或改动用户资料。 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron, expect, test } from '@playwright/test';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../../../..');

test('长路径不挤压日期，中文控件保持横向，行操作互不重叠且不触发打开', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  const folder = mkdtempSync(join(tmpdir(), 'evowork-table-layout-'));
  await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { TOKENS_CSS } from '@evowork/tokens';
        import { Library } from './apps/desktop/src/renderer/views/library';
        import { DataTable } from './apps/desktop/src/renderer/components/panels';
        import { PillButton, SegmentedControl } from './apps/desktop/src/renderer/components/primitives';
        import './apps/desktop/src/renderer/styles/app.css';
        const style = document.createElement('style'); style.textContent = TOKENS_CSS; document.head.append(style);
        const longPath = '/Users/example/Desktop/AI_COMPANY/' + '季度报告与资料目录/'.repeat(18);
        const rows = [{id:'one', name:'sectors-indices-2026-09-23-季度总结.png', source:'artifact', owner:'我', location:longPath, accessedAt:Date.now()-3*86400000, artifactType:'image', extension:'png'}, {id:'two', name:'AI 图片', source:'artifact', owner:'我', location:longPath+'media', accessedAt:Date.now()-8*86400000, artifactType:'image', extension:'png'}];
        const data = {rows, bodySearchEnabled:true, projects:[], revision:1};
        const actions = {getOcrRuntime:async()=>null, getLibrary:async()=>data};
        const shares = [{id:'share',name:rows[0].name,url:'https://example.invalid/share',expiresLabel:'还有 3 小时',accessCount:42,state:'active',hasPassword:true}];
        function View() {
          const [mode,setMode] = useState('library');
          const [opened,setOpened] = useState(0);
          const [acted,setActed] = useState(0);
          return <><SegmentedControl ariaLabel="测试页面" value={mode} items={[{id:'library',label:'资料库页面'},{id:'table',label:'通用表格页面'}]} onChange={setMode}/>
          <output aria-label="打开次数">{opened}</output><output aria-label="操作次数">{acted}</output>
          {mode==='library' ? <Library rows={rows} data={data} actions={actions} shares={shares} onShare={()=>setActed(v=>v+1)} onOpen={()=>setOpened(v=>v+1)} tipDismissed/>
          : <DataTable ariaLabel="多列表格" rows={[{id:'a'}]} onRowClick={()=>setOpened(v=>v+1)} columns={[
            {id:'name',header:'名称',render:()=> '中文与English名称'.repeat(30)},
            {id:'time',header:'最近访问',nowrap:true,render:()=> '2026/10/16 12:30:00'},
            {id:'summary',header:'错误摘要',render:()=> 'VeryLongUnbrokenToolName'.repeat(30)},
            {id:'status',header:'执行状态',nowrap:true,render:()=> '已完成'},
            {id:'usage',header:'访问次数',nowrap:true,render:()=> '123,456'}
          ]} rowActions={()=> <>{['分享','继续/重建索引','更新副本','识别文字','移除'].map(label=><PillButton key={label} variant="ghost" onClick={()=>setActed(v=>v+1)}>{label}</PillButton>)}</>}/>}</>;
        }
        createRoot(document.getElementById('root')).render(<View/>);
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
  writeFileSync(
    join(folder, 'main.cjs'),
    `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const win=new BrowserWindow({width:1200,height:800});win.loadFile(${JSON.stringify(join(folder, 'view.html'))});});`,
  );
  const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env;
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [join(folder, 'main.cjs')],
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('table', { name: '资料列表' })).toBeVisible();
    for (const mode of ['资料库页面', '通用表格页面']) {
      await page.getByRole('tab', { name: mode, exact: true }).click();
      for (const width of [1200, 900, 480]) {
        await app.evaluate(
          ({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 800),
          width,
        );
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
        const geometry = await page.locator('.ew-data-table').evaluate((table) => {
          const problems = [];
          const singleLine = (el) => {
            const range = document.createRange();
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const lines = [];
            while (walker.nextNode()) {
              if (!walker.currentNode.textContent.trim()) continue;
              range.selectNodeContents(walker.currentNode);
              lines.push(...[...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
            }
            return new Set(lines.map((r) => Math.round(r.top))).size <= 1;
          };
          for (const el of table.querySelectorAll('th, .ew-pill-label')) {
            if (!singleLine(el)) problems.push('文字被拆行: ' + el.textContent);
          }
          for (const cell of table.querySelectorAll('.ew-data-table-actions')) {
            const buttons = [...cell.querySelectorAll('button')];
            for (let i = 0; i < buttons.length; i++) {
              const a = buttons[i].getBoundingClientRect();
              const text = buttons[i].querySelector('.ew-pill-label');
              if (text && text.getBoundingClientRect().bottom > a.bottom + 1)
                problems.push('按钮文字超出: ' + text.textContent);
              for (const other of buttons.slice(i + 1)) {
                const b = other.getBoundingClientRect();
                if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
                  problems.push('按钮重叠');
              }
            }
          }
          for (const cell of table.querySelectorAll('[data-nowrap="true"]')) {
            if (!singleLine(cell)) problems.push('短值被拆行: ' + cell.textContent);
          }
          const scroll = table.parentElement;
          return {
            problems,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            tableOverflows: scroll.scrollWidth > scroll.clientWidth + 1,
          };
        });
        await page.screenshot({ path: testInfo.outputPath(`${mode}-${width}.png`) });
        expect(geometry.problems).toEqual([]);
        expect(geometry.overflow).toBe(false);
        if (width === 1200 && mode === '资料库页面') expect(geometry.tableOverflows).toBe(false);
      }
    }
    const action = page.getByRole('button', { name: '继续/重建索引', exact: true });
    await action.focus();
    await expect(action).toBeInViewport();
    await action.press('Enter');
    await expect(page.getByLabel('操作次数')).toHaveText('1');
    await expect(page.getByLabel('打开次数')).toHaveText('0');
    const row = page.getByRole('table', { name: '多列表格' }).locator('tbody tr');
    await row.focus();
    await row.press('Enter');
    await expect(page.getByLabel('打开次数')).toHaveText('1');
    await action.click();
    await expect(page.getByLabel('操作次数')).toHaveText('2');
    await expect(page.getByLabel('打开次数')).toHaveText('1');
    await page.getByRole('tab', { name: '资料库页面', exact: true }).click();
    await page.getByRole('tab', { name: '我分享的', exact: true }).click();
    await expect(page.getByRole('table', { name: '我分享的' })).toBeVisible();
    await page.getByRole('button', { name: '撤销分享', exact: true }).focus();
    await expect(page.getByRole('button', { name: '撤销分享', exact: true })).toBeInViewport();
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('Web 表格的长标识可横向滚动，中文表头与按钮不被挤成竖排', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  const folder = mkdtempSync(join(tmpdir(), 'evowork-web-table-layout-'));
  await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { TOKENS_CSS } from '@evowork/tokens';
        import { Button } from './apps/web/src/components';
        import './apps/web/src/app.css';
        const style = document.createElement('style'); style.textContent = TOKENS_CSS; document.head.append(style);
        createRoot(document.getElementById('root')).render(<div className="ew-table-wrap" role="region" aria-label="管理端表格滚动区域" tabIndex={0}><table className="ew-table" aria-label="管理端表格"><thead><tr><th>用户</th><th>配额班级</th><th>当期用量</th><th>操作</th></tr></thead><tbody><tr><td>{'LongUnbrokenIdentifier'.repeat(40)}@example.invalid</td><td>标准班级</td><td>123,456 tokens</td><td><div className="ew-actions"><Button>调整配额</Button><Button>收回管理员</Button></div></td></tr></tbody></table></div>);
      `,
    },
    nodePaths: [join(root, 'apps/web/node_modules')],
    outfile: join(folder, 'view.js'),
    bundle: true,
    jsx: 'automatic',
    platform: 'browser',
  });
  writeFileSync(
    join(folder, 'view.html'),
    '<html><head><meta charset="utf-8"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>',
  );
  writeFileSync(
    join(folder, 'main.cjs'),
    `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({width:900,height:600});win.loadFile(${JSON.stringify(join(folder, 'view.html'))});});`,
  );
  const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env;
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [join(folder, 'main.cjs')],
    env,
  });
  try {
    const page = await app.firstWindow();
    for (const width of [1200, 900, 480]) {
      await app.evaluate(
        ({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 600),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      const geometry = await page.locator('.ew-table-wrap').evaluate((wrap) => {
        const headers = [...wrap.querySelectorAll('th')];
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          scrolls: wrap.scrollWidth > wrap.clientWidth,
          headersFit: headers.every((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return (
              range.getBoundingClientRect().height <=
              parseFloat(getComputedStyle(el).lineHeight) + 1
            );
          }),
          buttonsFit: [...wrap.querySelectorAll('button')].every((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect().height <= el.clientHeight;
          }),
          shortValuesFit: [...wrap.querySelectorAll('td')].slice(1, 3).every((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return (
              new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size <= 1
            );
          }),
        };
      });
      expect(geometry).toEqual({
        overflow: false,
        scrolls: true,
        headersFit: true,
        buttonsFit: true,
        shortValuesFit: true,
      });
      await page.locator('.ew-table-wrap').evaluate((wrap) => {
        wrap.scrollLeft = 0;
      });
      await page.locator('.ew-table-wrap').hover();
      await page.mouse.wheel(600, 0);
      await expect
        .poll(() => page.locator('.ew-table-wrap').evaluate((wrap) => wrap.scrollLeft))
        .toBeGreaterThan(0);
      await page.locator('.ew-table-wrap').evaluate((wrap) => {
        wrap.scrollLeft = wrap.scrollWidth;
      });
      await expect(page.getByRole('button', { name: '收回管理员' })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`web-${width}.png`) });
    }
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
