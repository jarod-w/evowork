# 生图后查看与回合收尾 Playwright 验收（2026-10-07）

用户场景：输入「生成一张天空图片」，图片成功交付，但查看图片后回合因上下文超限失败。网关修复将工具内容块中的图片传为视觉输入，避免把 Base64 序列化成文字上下文。

后续变更（2026-10-07）：用户要求因上游问题暂时删除 Lite。当前真实套件仅含 Flash / Pro，Lite 的别名和型号 ID 均禁用；以下三型号测试结果保留为移除前的历史证据，没有改成三项通过或重新付费测试。移除后的本机回归、完整检查和构建结果见 [开发状态](../status.md)。

## 用例与边界

- `apps/desktop/test/e2e/ui/image-generation.spec.mjs`：本机三例，覆盖大图生成、查看、成功收尾、图片操作卡、结果预览、刷新后重新打开、零重复请求；拒绝费用确认后零请求；服务商 404 明确记录 `IMAGE_MODEL_UNAVAILABLE`。
- `apps/desktop/test/e2e/ui/image-generation.real.spec.mjs`：Flash / Lite / Pro 各一例真实 Ark 图片请求。
- 两套均使用真实 Electron、发货内核、图片 MCP、本机交付服务、SQLite 权威操作记录与产品网关翻译。Playwright 操作真实 DOM，并经公开 IPC 核对操作状态和产物。
- Chat 上游使用可控夹具，依次调用 `image_generate` 和 `view_image`。夹具检查图片进入视觉消息；旧网关将图片塞入工具文本时返回上下文超限。本轮没有调用真实聊天模型，不代表模型规划或视觉理解质量。
- 真实图片请求最多每例一次，重试关闭。第二次请求在到达 Ark 前拒绝。密钥从隐藏 stdin 进入进程环境，不进入源码、设置输入框或日志。

## 执行结果

| 测试 | 结果 | 证据 |
| --- | --- | --- |
| 本机三例 | 3 通过，18.4 秒 | `/private/tmp/evowork-image-ui-fixture-green.log` |
| 临时旧网关，大图例 | 1 失败，产物已出现但上下文超限 | `/private/tmp/evowork-image-ui-old-red.log` |
| 真实 Ark 三例 | 2 通过 / 1 失败，约 2 分钟 | `/private/tmp/evowork-image-ui-real.log` |
| 全仓 `pnpm run check` | 2713 通过 / 2 项原有跳过，退出 0 | `/private/tmp/evowork-image-playwright-check-complete.log` |

旧网关从当前 HEAD 的翻译文件构建到临时目录，用 `EVOWORK_UI_IMAGE_GATEWAY_ENTRY=/private/tmp/evowork-image-ui-old/main.js` 指定；未切换或改写工作区源码。对照结果证明窗口用例能抓住原始故障。

| 选择项 | 实际 model ID | 真实服务结果 |
| --- | --- | --- |
| Flash | `doubao-seedream-5-0-flash-260915` | 通过，2816×1584 PNG；查看、收尾、预览、刷新恢复通过 |
| Lite | `doubao-seedream-5-0-260128` | 失败，服务商 HTTP 404；操作状态 `failed`、错误码 `IMAGE_MODEL_UNAVAILABLE`，未重试 |
| Pro | `doubao-seedream-5-0-pro-260628` | 通过，2816×1584 PNG；查看、收尾、预览、刷新恢复通过 |

Flash / Pro 的调用统计均为 `imagePosts=1`、`viewCalls=1`、`visualRequests=1`、`imageBytesInToolText=false`。视觉输入 URL 长度分别为 4,329,846 / 4,699,502 字符，PNG 签名、尺寸与产物索引核验通过，独立查看图片确认为蓝天白云。

Lite 失败后只读核对该用例的产品权威操作记录，确认已提交且失败；网关将服务商 HTTP 404 映射为上述错误码。只读 Ark `/models` 查询 HTTP 200，仍列出 Lite 对应型号，但 `status=Retiring`。这些证据不能区分服务下线、区域或账号访问范围，不更换型号、不把目录存在当作出图成功。真实套件保留失败结果，未跳过。

共发出三次真实生成请求，两次取得图片；没有自动重试。实际费用未取得，单次样本不代表稳定率。Lite 故障发生在查看图片之前，与原始 Base64 上下文超限原因不同。

## 输出与复跑

本机输出位于 `/private/tmp/evowork-image-ui-fixture-green-results`，旧网关失败证据位于 `/private/tmp/evowork-image-ui-old-red-results`。真实输出位于 `/private/tmp/evowork-image-ui-real-results`，成功用例目录保存 `generated-sky.png`、`completed-window.png`、`image-statistics.json`，失败目录保存 `error-context.md`。这些是当前机器临时文件，不随仓库提交。

```bash
pnpm exec playwright test image-generation.spec.mjs --project=fake
read -rs EVOWORK_UI_IMAGE_KEY
export EVOWORK_UI_IMAGE_KEY
pnpm exec playwright test image-generation.real.spec.mjs --project=real --retries=0
unset EVOWORK_UI_IMAGE_KEY
pnpm run check
```

默认 Ark 北京 v3 地址；使用仓库已配置的三个型号 ID。项目需先完整构建。本轮完整构建已在网关修复后通过，新增用例直接使用该构建。本机最后一轮另修正了夹具对 MCP 结果说明文本的兼容解析，并增加失败诊断；真实付费三例没有再次运行。整 App 重开、真实聊天模型规划/视觉理解及其它平台窗口未在本轮验证。
