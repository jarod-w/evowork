# services/runtime-installer —— 完整办公运行时的本地部署（L3）

设计：[08 §4](../../docs/design/08-artifacts-and-ingest.md#4-解析运行时的分发r10-的落点)。

正式应用始终传入 `prebuiltRuntimeDir`（`Resources/office/runtime/`）：

```
校验平台/清单/自包含链接 → 复制到 staging → 实际 Python/包版本/模块/字体验收 → 原子换入
```

首次启动自动部署缺失组件（已有可用环境/管理员覆盖保留），首次启动直接进入主界面，没有首次引导，设置保留修复。
部署不运行 pip、不处理字体、不访问网络，资源缺失或损坏明确提示重新安装 EvoWork。
取消或失败清理 staging 并保留原运行时；并发请求继续共用安装锁。
最终路径仍为 `~/.evowork/runtime/office/`，解析与技能共用，保留管理员解释器覆盖。

`scripts/build-office-runtime.mjs` 在构建机复用旧安装流程（固定 CPython 下载 + pip + 静态字体），
或从旧式离线 wheel 包/已装完整环境准备成品；搬迁后再次验收。
清单 `.evowork-runtime.json`、目标平台 `.evowork-bundle.json` 与 `installed-packages.json` 随成品保留。
禁止直接打包普通虚拟环境或指向构建机目录的符号链接。

旧在线/离线 wheel 安装仅供构建/显式开发；`prebuiltRuntimeDir` 优先，失败不回退。
OCR 安装器继续独立。`ingest` 保持整个 src 目录不出网。

验证：`pnpm run check`；打包后 `node scripts/verify-packaged-app.mjs` 会从实际应用资源向全新临时目录部署，
下载函数被禁止、进程调用仅允许解释器验收，完成真实模块/版本/字体检查。
