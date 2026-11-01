# Windows x64 基础版发布准备

用户于 2026-11-01 确认先做 Windows x64 基础版，电脑操控与 OCR 关闭。
本文区分已完成的源码适配、可在当前 macOS 开发机验证的内容、仍需 Windows 的发行验收。
**Windows 安装包尚未在本轮生成或发布，Windows 工作流尚未运行，不代表已支持所有 Windows 版本。**

## 首版范围

| 能力 | 基础版处理 |
|---|---|
| 对话、任务、项目、审批、文件交付、办公产物生成 | 保留，需 Windows 发货内核与安装包端到端验收 |
| Office 附件正文解析 | 保留独立的办公解析器；不能把移除代理环境当作 OS 断网保证 |
| 文本类资料库正文索引 | 保留 txt/md/csv/tsv/json；复杂格式受限解析不可用时明确说明并保留文件名检索 |
| Office 版式预览、PDF 页图 | macOS 隔离实现不移植成无隔离执行；Windows 版式预览明确回退正文，原文件可用本机应用打开 |
| OCR | 附件识别/继续/使用部分结果、资料库识别、安装入口与运行时探测均关闭；即使存在旧组件或环境覆盖也不开启 |
| 电脑操控 | 不注册可用工具，宿主状态 unsupported；启动时将已有 MCP 配置写为禁用 |
| 完全访问 | 保持禁用，`WINDOWS_ISOLATION='unknown'`；U5 未关闭 |
| 架构 | 仅原生 Windows x64；不宣称 ARM64 或 x86 发行支持 |

## 已做的适配

- 构建脚本用当前 Node 启动 JS CLI，esbuild 走 API；从桌面包解析 Vite，避免 `.bin`/`.cmd` 的进程启动差异。
- Git 文本 checkout 固定 LF，避免 Windows 自动换行破坏模式指令和补丁的字节哈希。
- 内核构建同时准备 `codex-app-server.exe`、`codex-windows-sandbox-setup.exe`、`codex-command-runner.exe`。来源清单逐个记录 SHA-256，缺辅助程序或哈希不符时拒绝打包。
- Windows 策略 hooks 不再跳过。命令使用 PowerShell UTF-16LE 编码参数，设置 UTF-8 输入输出、Electron Node 环境与退出码；路径不进入 cmd 的环境变量展开。沿用既有内核加载/信任链路，原生执行测试仅在 Windows 运行。
- 启动迁移在 Windows 未显式设置沙箱时补 `windows.sandbox="elevated"`，不依赖默认关闭的上游旧 feature 开关；已有明确模式保留，首次配置/UAC 仍待真机验证。
- 路径策略的 Windows 比较忽略大小写；任务工作目录、附件迁移/来源检查使用本平台分隔符。内核入口显式选择 `.exe`，后台内核、网关与 Python 探测隐藏控制台窗口。
- NSIS 目标显式限制 x64。缺 Windows 签名凭据时关闭代码签名、保留资源编辑并标记 `-unsigned`，不显示 Mac 的安装提示。
- 发布脚本支持 `--platform win32 --arch x64`，读取/签名/上传 `latest.yml`，验证 Windows 解包目录中的公钥；不覆盖 `latest-mac.yml`。本地 staging 使用 Node 复制与原子替换，不依赖 rsync；SSH 发布仍要求发版机有 ssh/rsync，可在 macOS 发版机发布 Windows 产物。
- Windows extraResources 在复制时可能被 Authenticode 改写；打包 hook 核对构建源与复制的来源清单，再记录最终哈希，同时保留签名前组件哈希。签名实际链路仍待证书与 Windows 验收。
- 增加 `verify-windows-package.mjs`：检查必需资源、PE x64 架构、内核与辅助程序来源；在 Windows x64 上另验完整 Python 运行时和随包 Electron Node/SQLite。`--static` 只查文件结构，不能作为启动验收。
- 增加手动 GitHub Actions `Windows x64 candidate`，锁定内核提交 SHA，构建、检查并上传标记为 `unsigned-unverified` 的候选产物；不会上传更新源或创建发布。

## Windows 构建步骤（待在原生 Windows 验证）

在 Windows x64 上准备 Node（仓库要求 ≥22.12）、pnpm 10.30.3、Git、MSVC C++ 构建工具与内核锁定的 Rust 工具链。
产品与只读内核签出为同级目录。内核提交必须与本次产品协议检查和补丁一致；工作流默认 SHA 来自本轮实际内核签出。
以下 PowerShell 命令是待验收操作说明，**本轮没有在 Windows 执行**：

```powershell
pnpm install --frozen-lockfile
pnpm run check
node scripts/build-kernel.mjs
node scripts/build-office-runtime.mjs
pnpm run build
pnpm run package -- --arch x64
node scripts/verify-windows-package.mjs
```

`pnpm run check` 包含的历史测试中仍可能存在 Unix 专用夹具；Windows 工作流先跑类型检查及已列明的 Windows 定向回归，不能把该子集当作全仓 Windows 测试已通过。
办公运行时必须在目标机器安装依赖、搬迁后验证，禁止复制 Mac Python 或拿未验收的跨架构运行时出包。

原生 hook 测试：

```powershell
node node_modules/vitest/vitest.mjs run apps/desktop/test/windows-hooks.test.ts
```

检查 cmd → PowerShell → Node 的 stdin、中文 stdout、含空格/单引号/&/%/! 路径与失败退出码。
还需对实际安装的 Electron 与发货内核重做，不以 Node 测试替代 hook 的内核信任验收。

## 发布准备（仍不等于发布许可）

沿用既有干净工作树、版本 tag、更新说明、升级夹具和清单签名公钥检查，不在本轮升级版本。
Windows 构建的整个 `dist/release`（含 `win-unpacked`）交给发版机；不要只复制 exe 后跳过嵌入公钥检查。

```powershell
node scripts/publish-release.mjs --platform win32 --arch x64 --dest C:\release-staging --kid evowork-update-1 --key-file C:\private\update-key.pem --dry-run
```

这条命令仅预检，不签名、不上传；路径和 kid 为示例。移除 `--dry-run` 是实际发布动作，须在下表的发货验收完成后由发版人员执行。
应用代码签名凭据为 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`，更新清单签名是另一套现有密钥，不能相互替代。

## 必须单列的 Windows 真机验收

| 项目 | 要完成的验证 | 当前状态 |
|---|---|---|
| 首次构建 | Rust/MSVC、补丁、沙箱辅助程序、Python wheel/DLL/字体、NSIS、体积预算；保存内核提交与完整日志 | 待验 |
| 干净安装 | 没有 Node/Python 的普通用户机器安装、启动、无白屏；中文及空格用户名/安装路径 | 待验 |
| 实际 hooks | 发货内核加载并信任所有事件；敏感路径拒绝、普通文件审批、拒绝无副作用、审计入库、hook 故障可见 | 待验 |
| 上游沙箱 / U5 | 首次配置与 UAC、拒绝/取消安装、辅助程序启动、读写/联网/子进程限制；大小写、junction、UNC、长路径、盘符等边界；确认无静默放宽 | 待验；完全访问继续禁用 |
| 密钥 / U6 | Windows DPAPI 保存与重启读取、不可用提示、换 OS 账号不可解密；日志与 renderer 不泄密 | 待验 |
| 基础业务 | BYOK/登录与 PKCE 回调、多轮任务、三类 Office 产物生成并读回、附件引用、项目、自定义工作目录、文件打开/撤销 | 待验 |
| 禁用范围 | 即使设置 OCR 环境变量或存在旧组件也不可安装/识别；电脑操控始终不可启用；完全访问在 UI 与宿主均拒绝 | 待验 |
| 浏览器 | 找到本机 Chrome/Edge 的实际支持范围；研究/表单审批、下载、取消、taskkill 结束进程树且无残留请求 | 待验 |
| 恢复与调度 | 退出/崩溃/重开后任务、排队、文件索引和预算恢复；睡眠/唤醒与定时漏跑策略 | 待验 |
| 深链 | 安装注册 `evowork://`；冷启动、第二实例、已有窗口接收，未知链接拒绝 | 待验 |
| 更新 | `latest.yml` 的验签、错误签名/哈希拒绝、下载、平台架构选择；旧版覆盖安装保留数据 | 待验 |
| 签名 / U4 | 取得证书，安装器、主程序、内核辅助程序的 Authenticode/时间戳/来源哈希检查，系统实际安装提示 | 待验 |
| 卸载与兼容性 | 卸载不误删用户工作文件，重装可恢复本地数据；先验 Windows 11 x64，其余系统版本另记兼容性 | 待验 |

当前 macOS 验证证据与失败过程见 [本轮验收记录](verification/2026-11-01-windows-x64.md)。
