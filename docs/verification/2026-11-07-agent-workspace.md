# 智能体工作台：前端评审实现与验收

## 交付范围

按用户确认的 HTML 原型，将“智能体”接入桌面 React 前端，位于“插件”下方。实现列表与筛选、单体配置与实时预览、团队与成员配置、节点编排、运行监控、人工确认及停止展示。复用应用侧栏、token、基础控件与离开确认机制。

用户本轮只要求前端供 Review。初始示例与保存结果均为 React 会话状态，切换导航可保留；刷新恢复示例。对话入口只预览输入，运行日志与节点结果明确标注模拟。没有新增 IPC、后台接口、数据库、角色发布、模型请求或真实任务。

## 验证

- `pnpm run build:renderer` 通过，产物为真实应用渲染层。
- 页面新增 4 项行为回归通过，覆盖会话配置、任务预览、转义、离开保护、删除确认、运行确认/停止与空态。
- App 140 项回归通过，包括新增入口选中态、插件保留、跨导航保存、设置页离开保护，以及没有调用 `send` / `createExpert`。
- 样式 31 项、侧栏 39 项回归通过。
- 真实 Electron 窗口 + 原有发货内核，最终 Playwright **1/1（10.8 秒，零重试、零跳过）**。验证任务总数未增加；1440 宽的列表、单体、团队、流程及监控，以及 900 / 600 / 480 宽团队/流程/监控和 480 宽单体页面均有截图。

完整 `pnpm run check` **退出 0**：211 个测试文件通过、1 个既有跳过；**3442 项通过、2 项既有跳过**，测试耗时 204.80 秒。格式、lint、类型检查、内核补丁预算、协议形状与许可证清单均通过。最终窄窗 CSS 与窗口测试单独完成格式复核和渲染构建，样式回归在最终完整检查中通过。

## 窄窗修正

人工查看截图发现折叠侧栏后，恢复按钮覆盖顶部文字。新增几何断言在旧布局失败：顶部文字 x=24，按钮右边界 x=38。修正只在智能体页面窄窗顶部预留 token 间距，最终同一断言及完整旅程通过；修正后截图已查看。

首次窗口旅程的选择器用 label 全文精确匹配 select，包含 option 文本导致超时；改为按 combobox 可访问名称定位，未放宽功能断言。失败时有未保存草稿，关闭会触发原生 beforeunload；测试显式处理该确认以便清理隔离进程。

## 环境与边界

只验 macOS arm64。测试使用隔离数据，Review 窗口复用已有测试宿主并使用示例配置；不替换安装版。未实现或验证真实智能体执行、独立工具权限、连接器授权、后台持久化、发布和跨平台行为。

当前共享工作区另有 Composer 发送恢复的改动，本轮未回滚或提交它们；全仓检查针对执行时的共享工作区。系统默认 pnpm 11 的版本切换校验报错，命令改用已经安装的项目指定 pnpm 10.30.3。受限环境的完整检查有回环端口 EPERM，最终检查允许本机端口，并将测试并发限制为 1、指定已有随包办公运行时。

证据位于 [截图和日志目录](assets/2026-11-07-agent-workspace/)。

```bash
PATH="/Users/wangli/Library/pnpm/.tools/pnpm/10.30.3/bin:$PATH" pnpm run build:renderer
node node_modules/vitest/vitest.mjs run apps/desktop/test/agent-workspace.test.tsx apps/desktop/test/app.test.tsx apps/desktop/test/styles.test.ts apps/desktop/test/sidebar.test.tsx
node node_modules/@playwright/test/cli.js test agent-workspace.spec.mjs --project=fake --retries=0
PATH="/Users/wangli/Library/pnpm/.tools/pnpm/10.30.3/bin:$PATH" VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 EVOWORK_OFFICE_PYTHON="$PWD/build/office/mac-arm64/runtime/bin/python3" pnpm run check
```
