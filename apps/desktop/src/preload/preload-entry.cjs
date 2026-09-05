/**
 * preload 的真实入口 —— 与 `main/electron-entry.mjs` 对称。
 *
 * `index.ts` 刻意不 import electron（见它的头注释：「暴露了哪些方法」必须是一条可断言的
 * 事实），所以那个文件只导出 `installBridge`，**没有任何自调用**。少了这个入口，
 * 打包出来的 preload 是一段谁也不会执行的代码：`window.evowork` 不存在，
 * 渲染层的每一次调用都是 `undefined is not a function`，而主进程一切正常 ——
 * 这种失败方式最费时间，所以入口必须显式存在。
 *
 * ## 为什么是 .cjs，而不是 .ts 或 .mjs
 *
 * `WINDOW_SECURITY.sandbox` 是 **true**（bootstrap.ts）。Electron 的沙箱化 preload
 * **不支持 ESM**：ESM preload 既要求 `.mjs` 后缀，又要求关掉 sandbox ——
 * 而关沙箱不在选项里（R5）。所以这个入口与它的打包产物都必须是 CommonJS。
 *
 * 后缀写死 `.cjs` 而不是 `.js`：`apps/desktop/package.json` 是 `"type": "module"`，
 * 在这里一个叫 `.js` 的 CommonJS 文件是自相矛盾的，Node 侧的任何一次直接加载都会炸。
 *
 * 写成 JS 而不是 TS 的理由与 electron-entry.mjs 相同：`electron` 是 M9 才装的依赖，
 * 写成 .ts 会被 tsconfig.main.json 的 preload 通配收进去，然后因为找不到模块
 * 让 typecheck 红一片没有信息量的错。
 */
const { contextBridge, ipcRenderer } = require('electron');

// 不写后缀：esbuild 按 resolveExtensions 找到同目录的 `index.ts` 并把它打进产物。
// 写成 './index.js' 反而不行 —— 那个文件不存在，而 TS 的 .js→.ts 改写只对 TS 导入方生效。
const { installBridge } = require('./index');

installBridge(contextBridge, ipcRenderer);
