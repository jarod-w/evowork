# 2026-10-24 · 完整办公 Python 运行时随 DMG 分发

> 后续：已删除整个首次引导，改为启动自动准备办公组件，见[最终首次启动验收](2026-10-24-first-launch-without-onboarding.md)。本文保留上一轮随包运行时的原始验证记录。

## 行为与实现

- 构建阶段运行 `scripts/build-office-runtime.mjs`，安装 Python、固定版本的办公包及全部传递依赖，生成静态中文字体，并运行依赖一致性与模块/版本/字体检查。普通开发机虚拟环境不可直接打包。
- 输出 `build/office/<os>-<arch>/runtime/`，带运行时清单戳、目标平台与完整包版本清单。命令脚本的绝对 shebang 改成同目录解释器；禁止绝对或树外符号链接，在最终搬迁位置再次验收。
- electron-builder 把完整目录放进 `.app/Contents/Resources/office/runtime/`，随 DMG/ZIP 交付；打包前成品缺失、清单过期、架构不符、真实探针失败或超过目录预算均拦截。
- 正式入口经 bootstrap → service-host → local-services 传递成品路径；路径缺失也不切回网络安装。引导/设置中的安装只复制到 staging，验收后原子换入用户办公运行时目录，零下载、零 pip、零字体处理。错误/取消保留旧环境，换入失败恢复旧目录。
- 管理员解释器覆盖与旧版运行时保留；旧式 wheel 包仅用于构建/显式开发兼容。OCR 仍独立。
- 总纲 D9/R10、08 §4、02 引导、09 服务层、architecture、构建部署、CLAUDE 与相关 README/许可清单同步。

## 验证记录

本机：macOS arm64。构建输入复用本机已安装、清单一致的完整 Python 运行时，复制后重新校验，不修改原运行时。

```bash
node scripts/build-office-runtime.mjs --from-runtime /path/to/installed/office
pnpm run build
pnpm run package
node scripts/verify-packaged-app.mjs
```

- 已验证搬迁后 Python 版本、目标平台/CPU、六个办公包的固定版本、模块导入、Noto Sans SC 家族，以及 `pip check` 无缺依赖。`pip --version` 在最终成品位置正常返回。
- 新增回归覆盖全新部署零下载/零 pip、缺成品、错误平台、错误清单、树外/绝对链接、失败保留旧环境、取消后不换入；另验证有空格的搬迁目录中命令脚本确实调用同目录解释器、交叉架构构建拒绝、打包缺成品拒绝和桌面宿主路径接线。
- 首轮实际 `.app` 冒烟通过：成品向全新临时目录复制并实际验收，下载函数被禁止、进程调用仅允许解释器校验；首次引导、argv 深链、协议注册和单实例转发沿用既有冒烟通过。该冒烟不证明 macOS `open-url` 的系统派发链路。
- 实测安装后办公目录约 282 MiB；DMG 约 295.2 MiB、ZIP 约 300.1 MiB，分别低于办公目录 350 MiB 与压缩安装包 400 MiB 预算。

最终验收：

- `pnpm run check`（限制 Vitest 并发为 2，使用本机已有 pnpm/store）：**退出 0，3417 项通过、2 项既有跳过**；207 个测试文件通过、1 个既有条件跳过文件。format/lint/类型、内核预算、协议、许可清单全部通过；测试运行约 172 秒。新增取消回归包含实际子进程被取消返回失败的情形，结果仍为 ABORTED、不换入。
- 最终完整构建、DMG/ZIP 打包及 `verify-packaged-app.mjs` **均退出 0**。最终实际随包目录向全新临时目录本地部署并核验模块/版本/字体通过，下载与 pip/字体处理进程被禁止；Electron 首次引导和既有启动冒烟通过。
- 最终 DMG 经 `hdiutil attach -readonly` 校验并挂载，镜像校验通过。用 `sandbox-exec` 的 `(deny network*)` 限制子进程网络，从**镜像内**的运行时部署到新临时 HOME。下载函数禁止、安装阶段仅允许解释器验收；随后真实生成并重新读取 DOCX、XLSX、PPTX，生成中文图表 PNG/PDF，并用 pdfplumber 从 PDF 提取到“离线办公验收”。JSON Schema 校验正常。测试退出 0，临时文件清理、镜像自动卸载。

禁网办公样例输出：

```json
{"offline": true, "pip_install": false, "documents": ["docx", "xlsx", "pptx", "pdf", "png"], "font": "Noto Sans SC"}
```

复验日志摘要保存在 [assets/2026-10-24-bundled-office](assets/2026-10-24-bundled-office/)。

## 过程与边界

初次沙箱内构建被 Swift 模块缓存权限和嵌套沙箱拦截；沙箱内全仓检查另遇回环 HTTP/OCR 子进程限制。未修改这些测试的断言或超时，改为使用本机已有 pnpm 10 与依赖 store，并在沙箱外执行构建/检查。
第一轮沙箱外全仓检查为 3416 通过、1 失败、2 既有跳过：唯一失败是 PPT 技能测试仍要求提示“120MB”。同步为“随应用提供，无需下载”后，该文件 26/26 通过并复跑完整检查。

本次未升级产品版本、发布安装包或替换已安装应用。生成的验证包仍为 ad-hoc 签名；Developer ID/公证（U4）、macOS x64 与 Windows/Linux 的实际运行尚未在本次验收完成。没有新增可用 OCR 发行包，也不将本次模块验收声明为完整办公产物视觉质量评分。
