# 直接使用随包运行时与后台启动验收

日期：2026-10-24。平台：macOS arm64。承接 [删除首次引导](2026-10-24-first-launch-without-onboarding.md)，本轮落实直接运行、主界面先显示和后台验证。

## 实现与边界

- 正式包优先 `Resources/office/runtime`，管理员 `EVOWORK_OFFICE_PYTHON` 覆盖保持；不复制到用户目录，不静默使用旧版用户运行时。解析、预览、资料库和内核技能共用所选路径。
- 注册 IPC、深链和退出处理后先加载主界面，再启动宿主。IPC 请求等服务就绪；输入区可编辑草稿并显示准备状态，服务就绪后恢复发送。
- 办公验证不阻塞内核启动。后台检查平台、清单和链接，用一个异步 Python 进程核对六包版本、模块与字体；预热数据目录的 Matplotlib 缓存，同一会话复用结果。状态查询不执行同步 import。
- 设置区分验证中、可用和失败，完成事件自动刷新；可重新验证，资源损坏需重新安装应用。办公附件解析等待验证；纯文本任务不等待办公验证。关闭应用取消验证，启动链路在退出后不继续拉服务。
- 本轮没有更改内核、调用真实厂商模型、升级版本、安装或发布应用。只验本机 macOS arm64；Developer ID、公证与其他平台仍未验收，U4 保持。

## 已完成验证

- 启动相关单元/集成 284 项通过。新增覆盖主界面先加载、IPC 等待、后台验证未完成仍完成内核握手、缓存和单进程探测、状态刷新、失败重试与退出取消。
- 完整桌面构建通过。
- 真实 Electron + 发货内核 + 确定性本机网关 UI **4/4，零重试/零跳过（12.1 秒）**：首次启动/刷新/零默认项目、实际保存目录、修改与恢复目录、多文件上传与带图片 Word/PPT 拖入。截图已查看。

```bash
node node_modules/@playwright/test/cli.js test '/(onboarding|working-directory|attachments)\.spec\.mjs$' --project=fake --retries=0
```

[UI 日志](assets/2026-10-24-direct-bundled-runtime-startup/ui.log) · [主界面截图](assets/2026-10-24-direct-bundled-runtime-startup/first-launch-main.png)

## 最终全仓检查

最终 `pnpm run check` 退出 **0**，**3407 项通过、2 项既有跳过**，208 个测试文件通过、1 个既有跳过；格式、lint、全部类型、内核补丁/协议与许可证门禁均通过。测试阶段 197.49 秒，原先超时的假 soffice 用例本轮 820 ms 通过，未修改其断言或 20 秒期限。

使用缓存的 pnpm 10.30.3，降低并发运行原版检查入口：

```bash
VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm run check
```

[全仓检查汇总](assets/2026-10-24-direct-bundled-runtime-startup/check-summary.log)

## 实际打包应用

最终完整构建、DMG/ZIP 打包与 `node scripts/verify-packaged-app.mjs` 退出 0。DMG/ZIP 约 295.2/300.1 MiB，仍在预算内，未安装或发布。

全新隔离数据目录、清除管理员解释器覆盖：主界面 **1963 ms** 可见，后台验证观察到就绪 **19106 ms**。这是一次本机全新数据目录测试，包含自动化启动开销，不是跨机器性能保证或 OS 冷缓存基准。文本服务不等待这 19 秒办公验证；办公操作等待共享验证，字体缓存为后续进程复用。

- 直接执行实际随包解释器，单个进程验证平台、包版本、模块与字体；字体缓存可写。
- 用户目录不存在 `runtime/office` 副本，存在 `cache/matplotlib`。
- 随包 Python 生成 Word，再由实际应用的正式附件 IPC 解析，正文包含测试标记。
- 原有冷启动 argv 深链、协议注册和单实例投递回归通过；macOS `open-url` 的 LaunchServices 实际派发仍未验，不能用 argv 测试替代。
- 上述验证、解析和应用退出完成后再次 `codesign --verify --deep --strict` 通过，包内资源未被改写。仍为 ad-hoc 签名，Developer ID/公证未验收。

[最终冒烟日志](assets/2026-10-24-direct-bundled-runtime-startup/smoke-final.log) · [打包日志](assets/2026-10-24-direct-bundled-runtime-startup/package.log) · [实际包首屏](assets/2026-10-24-direct-bundled-runtime-startup/packaged-first-launch.png)

## 过程记录

首次定向集成在沙箱中遇到回环监听 EPERM；允许本机服务后 284 项全过。完整检查修正了新状态字段的类型接线、新 UI 测试误用 Testing Library 的 `exact` 参数，以及格式化器需要第二次收敛的格式问题。没有放宽断言或增加超时。

首轮全仓测试 3406 项通过、2 项既有跳过，既有 documents 假 soffice 转换用例超过原 20 秒期限。后续降低并发复验；失败记录保留，不把这轮标为全量通过。

首次 UI 文件名按子串匹配，误包含需要独立 OCR 运行时的 `ocr-attachments.spec.mjs`，该项因缺少 OCR 环境明确失败；其余四项通过。随后用完整路径文件名正则重跑，最终四项全部通过。OCR 不在本轮验收范围。

实际包首轮验收发现 `-I` 会忽略 `PYTHONDONTWRITEBYTECODE`，Python 启动与早期 import 写回包内 `.pyc`，导致 codesign 封印校验失败；脚本内设置字节码开关太晚。改为进程参数 `-I -B`，常规解析/技能仍在启动前注入禁止写字节码环境；增加所有验证/解析/退出完成后的再次签名校验。最终以重建包复验，不能用原先打包成功替代运行后校验。

修复字节码写入后的首轮实际包因 Electron 自动化连接超时失败；诊断重跑能显示主界面，签名与实际 Word 解析通过，但冒烟脚本错误地使用 `waitForFunction(async ...)`，把 Promise 当作真值提前返回，读取的状态仍是 `checking: true`。改为 Node 侧 `expect.poll` 明确等待 `checking === false`；没有修改产品验证状态、断言目标或等待期限。此前两次“缺模块”结果属于这条测试等待错误，保留日志后重跑。

一次 Electron 自动化连接超时的根因未定位，后续验收通过不作为已修复该超时的证明；没有修改连接期限、产品安全设置或操作用户已安装应用的数据。
