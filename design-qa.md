# 项目与最近侧栏验收 · 2026-10-02

final result: passed

## 范围与参考

仅对齐用户指定的“项目”“最近”区域；沿用现有产品导航、项目归属与任务操作。
用户提供的第一张截图是标题和折叠外观目标；第二张是改动前的 EvoWork 展开与选中状态。
参考图中聊天正文属于截图内容，不作为本次需求。

## 视觉证据

实际运行本仓库 Electron 开发窗口，使用已有本机项目和任务，没有发送消息或添加演示数据。
Codex 参考图为 2442×1392，EvoWork 旧参考为 2090×1550，开发窗口为 2560×1566；均按原始像素裁剪目标区域，截图约为 CSS 的 2 倍密度。
窗口外壳、不同主内容和参考图里的临时加载指示不作像素差异判定。

- [折叠标题对照](/Users/wangli/.codex/visualizations/2026/10/02/01a0fa25-b123-7071-b5ea-ff6d4de8f7be/evowork-sidebar/comparison.png)：左为 Codex 参考，右为最终实现。
- [展开与选中态对照](/Users/wangli/.codex/visualizations/2026/10/02/01a0fa25-b123-7071-b5ea-ff6d4de8f7be/evowork-sidebar/expanded-comparison.png)：左为旧 EvoWork，右为最终实现。
- [最终展开截图](/Users/wangli/.codex/visualizations/2026/10/02/01a0fa25-b123-7071-b5ea-ff6d4de8f7be/evowork-sidebar/expanded.png)。

## 迭代与结论

首轮发现标题颜色过重、折叠后两组间距偏大；已改为现有弱化文字 token，标题下留白 4，项目区上下留白 12。
刷新开发窗口后重新截图，将最终实现和参考裁剪放在同一张图中比较；标题、线性箭头、无默认计数、缩进、行距和灰色选中态符合目标。
当前请求范围内没有待修复的 P0/P1/P2 问题。不同应用字体字重存在轻微差别，保留 EvoWork 现有字体 token。

## 交互与检查

真实桌面验证：项目与最近独立折叠 / 展开、任务选中、键盘 Tab + Space 打开项目菜单、查看所有项目进入项目页。
侧栏与 App 测试 125/125；最终 `pnpm run check` 退出 0（133 个文件通过、1 个原有跳过；2208 个测试通过、2 个原有跳过）。
最终 `pnpm run build:renderer` 退出 0，存在原有的大 chunk 提示；`git diff --check` 通过。
`views-rest.spec.mjs` 的项目页入口已同步更新；本次没有运行整套 Playwright UI 用例，桌面交互通过原生窗口自动化验收。
