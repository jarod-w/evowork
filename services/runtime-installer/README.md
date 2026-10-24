# services/runtime-installer —— 完整办公运行时的本地部署（L3）

设计：[08 §4](../../docs/design/08-artifacts-and-ingest.md#4-解析运行时的分发r10-的落点)。

正式应用始终传入 `prebuiltRuntimeDir`（`Resources/office/runtime/`）用于直接运行与后台验证。保留的构建/开发部署流程是：

```
校验平台/清单/自包含链接 → 复制到 staging → 实际 Python/包版本/模块/字体验收 → 原子换入
```

正式启动直接使用 `Resources/office/runtime/`，主界面先加载，后台单进程验证并预热可写字体缓存；不复制运行时、不联网、不运行 pip。设置可重新验证，损坏须重装应用，管理员解释器覆盖保持。

以上 staging/原子替换安装器仅用于构建或显式开发安装，目标为 `~/.evowork/runtime/office/`；取消/失败保留旧环境。正式包的探针、解析、预览与内核技能统一使用随包路径。

`scripts/build-office-runtime.mjs` 在构建机复用旧安装流程（固定 CPython 下载 + pip + 静态字体），
或从旧式离线 wheel 包/已装完整环境准备成品；搬迁后再次验收。
清单 `.evowork-runtime.json`、目标平台 `.evowork-bundle.json` 与 `installed-packages.json` 随成品保留。
禁止直接打包普通虚拟环境或指向构建机目录的符号链接。

旧在线/离线 wheel 安装仅供构建/显式开发；`prebuiltRuntimeDir` 优先，失败不回退。
OCR 安装器继续独立。`ingest` 保持整个 src 目录不出网。

验证：`pnpm run check`；打包后 `node scripts/verify-packaged-app.mjs` 直接验证实际随包解释器，检查单进程与可写缓存；再启动真实应用，记录主界面可见/验证就绪时间，断言用户目录没有运行时副本。
