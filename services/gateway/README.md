# services/gateway —— Responses API 网关（M1，**云端**）

设计：[总纲 D2 / K4](../../docs/evowork-on-codex-design.md) · Q2 / Q14 / Q16 · R1

**全项目最容易被低估的工作量**（R1，8 人周，关键路径最长的单项）。它不是薄转发：
`wire_api = "chat"` 已被上游移除（`model-provider-info/src/lib.rs:58`），内核**只认 Responses API**，
所以流式语义、工具调用、reasoning 段、prompt cache 口径全都得由网关补齐。

P0 三家（Q16）：**DeepSeek**（基准实现）· **Kimi** · **GLM-5.3-flash**（轻量档，M0 就拿它验产物质量下限）。

**模型表不止这三家**（M10a / 11 §4.1）：`layers.ts` 把它做成四层合并
**② 企业覆盖 > ②' 租户默认 > ③ 本机自定义 > ① 内置元数据**。三件事因此成立：
企业能锁模型（R11）· 用户能加私有 endpoint（Q29）· 托管与 BYOK 能共存（Q36=A）。
被停用的模型**留在目录里**（带一句能直接显示的原因），但 `/v1/responses` 会 403 拒掉它 ——
目录里列它、请求里拒它，两件事都要做。第③层的线上形状在 `custom-models.ts`，
**桌面宿主与网关共用同一个模块**（密钥不在那个 JSON 里，只有变量名）。

**六条语义必须逐家补齐**（D2 的矩阵，缺一项都会在真实任务里暴露）：流式事件序列 · 工具调用
（并行 / 增量 arguments）· reasoning 段 · prompt cache · 多模态输入 · token 用量口径。

**两条不可协商的纪律**：

1. **降级必须显式**（D2）—— 能力缺失要在响应里标注，前端据此隐藏对应 UI；
   **无思维链时留空占位，不得伪造**；不支持 cache 时如实上报 0 命中，避免配额口径失真。
2. **不落盘 prompt 与响应体**（Q14）—— 三条会泄露正文的路径都要管住：应用日志、
   APM trace（span attribute 不带 input/output）、错误上报（异常堆栈不得携带请求体）。
   这条是**对外可审计的承诺**，实现方式见 `packages/logging`：做成**代码层面的不可能**，不是约定。
