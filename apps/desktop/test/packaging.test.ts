/**
 * 打包相关的结构约束 —— **这些只在装完 dmg 双击那一刻才会暴露**，
 * 所以必须有测试把它们钉在构建之前。
 *
 * 2026-09-06 第一次真打包并启动时，下面每一条都被违反过一次，
 * 而失败的表现都不指向原因（窗口正常打开、标题栏正常、整页全白）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), 'utf8');

describe('渲染层在 file:// 下能加载（M9）', () => {
  it('vite 的 base 是相对路径 —— 绝对路径在 file:// 下指向文件系统根目录', () => {
    // 打包后的窗口走 `loadFile`，即 file://。vite 默认的 `base: '/'` 会生成
    // `<script src="/assets/xxx.js">`，在 file:// 下 404 → **整页全白，且没有任何报错**。
    expect(read('vite.config.ts')).toMatch(/base:\s*'\.\/'/);
  });
});

describe('Electron 入口的两条硬约束（M9）', () => {
  const entry = read('src/main/electron-entry.mjs');

  it('不在顶层 await bootstrap —— 那会和 whenReady() 死锁', () => {
    // ESM 入口的模块求值必须先结束 Electron 才发 ready，而 bootstrap() 第一件事
    // 就是 await whenReady()。顶层 await 它 = 互相等：
    // 进程活着、零个 Helper 子进程、一行输出都没有。
    expect(entry).not.toMatch(/^await bootstrap\(/m);
    // 而且失败必须响亮：rejected promise 在主进程里既不打印也不退出
    expect(entry).toMatch(/\.catch\(/);
  });

  it('引的是 esbuild 的单文件产物，不是 tsc 的输出', () => {
    // tsc 产物会顺着 workspace 包的 exports 去加载 TS 源码然后炸
    expect(entry).toContain('./bootstrap.bundle.js');
    // preload 必须是 .cjs：窗口开着 sandbox: true，而沙箱化 preload 不支持 ESM
    expect(entry).toContain('index.bundle.cjs');
  });
});

describe('preload 有真正的入口（M9）', () => {
  it('preload-entry.cjs 把真的 contextBridge / ipcRenderer 塞进 installBridge', () => {
    // index.ts 只导出 installBridge、从不自调用（那是刻意的，为了让"暴露了哪些方法"可断言）。
    // 少了这个入口，打包出的 preload 是一段谁也不执行的代码：window.evowork 不存在，
    // 而主进程一切正常。
    const cjs = read('src/preload/preload-entry.cjs');
    expect(cjs).toContain("require('electron')");
    expect(cjs).toMatch(/installBridge\(\s*contextBridge\s*,\s*ipcRenderer\s*\)/);
  });
});

describe('从访达启动也能拿到厂商密钥（M9 + M10a）', () => {
  /*
   * 装好的 App **不继承任何 shell 变量**，所以密钥必须有一个本机来源。
   *
   * M10a 换了那个来源：`~/.evowork/gateway.env`（明文）→ 系统钥匙串（Q34=A）。
   * 这条断言跟着换成新链路，但守的是同一件事：**这条链路存在**。
   * 它断过一次（宿主从不读那个文件），表现是本机网关走 NO_KEYS 而界面写成「连不上网关」。
   */
  it('密钥经密钥库进网关子进程，且 safeStorage 真的被注入', () => {
    expect(read('src/main/service-host.ts')).toContain('createModelAccess');
    expect(read('src/main/secret-store.ts')).toContain('encryptString');
    // 打包后唯一 import electron 的文件必须把 safeStorage 传进去，否则密钥库永远不可用
    expect(read('src/main/electron-entry.mjs')).toContain('safeStorage');
    expect(read('src/main/electron-entry.mjs')).toContain('gatewayEntryPath');
  });

  it('钥匙串不可用时仍读旧的 gateway.env —— 不静默让老机器失去密钥', () => {
    // 迁移要求密钥库可用；不可用时**不迁移、不改名、继续读**（见 model-access 的 legacyEnv）
    expect(read('src/main/model-access.ts')).toContain('parseGatewayEnv');
    expect(read('src/main/gateway-env.ts')).toContain('DEEPSEEK_API_KEY');
  });
});
