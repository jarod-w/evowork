# services/share —— 云端分享托管（**D9 第三条职责**）

| 项     | 值                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 里程碑 | Q41 / 08 §7 分享链路（2026-09-26 落地服务端与分享页）                                                              |
| 设计   | [11 §13.9 Q41](../../docs/design/11-account-and-models.md) · [08 §7](../../docs/design/08-artifacts-and-ingest.md) |
| 状态   | **服务端与 `/s/<id>` 页面已落地**。本机侧的「分享」按钮→授权→上传仍未接（见下文「还缺什么」）                      |

## 为什么它不在 `services/identity` 里

identity 的 DDL 被 [`no-content-schema.test.ts`](../identity/test/no-content-schema.test.ts)
守着：**不许出现能装任务 / 产物 / prompt 的列**。那条测试是「管理端结构上看不到内容」
这句对外承诺的实现处 —— 企业采购必问的那一条。

而分享托管存的就是**文件字节**。把它塞进 identity 会同时破掉那条测试和那句承诺。
所以它是自己一个服务、自己一套库、自己一个进程。D9 把「分享托管」列为四条云端职责
之一，这就是那一条的落点。

## 两组路由，鉴权方式**刻意不同**

| 组                                                                                 | 谁在调                    | 鉴权                                   |
| ---------------------------------------------------------------------------------- | ------------------------- | -------------------------------------- |
| `PUT /v1/shares`<br>`DELETE /v1/shares/:id`                                        | 本机客户端（上传 / 撤销） | identity 签的 access JWT（ES256 验签） |
| `GET /v1/s/:id`<br>`POST /v1/s/:id/unlock`<br>`GET /v1/s/:id/blob`<br>`GET /s/:id` | **没有账号的接收方**      | 无                                     |

读取那一组**不认 `authorization`、不种 cookie、不开 CORS credentials**
（11 §13.10 C 第 1 条，验收口径第 25 条）。`test/no-name-column.test.ts` 扫着这一条。

上传那一组的形状不是这里定的 —— 它是 [`services/artifacts/src/upload.ts`](../artifacts/src/upload.ts)
里写好很久的契约，这个服务是它一直缺的那一半。

## 云端**不知道文件名**

`upload.ts` 只上传 `x-evowork-name-digest`，理由写在那边：文件名可能本身就是敏感信息
（「XX公司裁员名单.xlsx」）。这条纪律在服务端的落点是 **DDL 里没有 name 列**，
在日志里的落点是**只记 `shareId` 与 `byteSize`**。

> ### 那接收方怎么看到文件名？
>
> **走链接片段**：`/s/<id>#<urlencoded-name>`。浏览器不会把 `#` 之后的内容发给服务器。
>
> 这一条解掉了两份设计文档的矛盾：08 §7.4 说页面要显示文件名，`upload.ts` 说云端不该
> 知道文件名。片段让两边都成立，而且比任一份都更严 —— **连我们自己的访问日志里都没有它**。
> 代价：链接经过某些会吃掉 `#` 的聊天工具时名字会丢，此时页面如实说「文件名未随链接传来」
> 并用 `<id>.<ext>` 兜底命名，**不因此拒绝下载**。
>
> 下载也因此走 fetch + object URL 而不是 `<a href>` 直下：服务器写不出
> `Content-Disposition` 的文件名，名字只在接收方的浏览器里。

## 安全面

| 规则                             | 落点                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **办公文件不在浏览器里渲染**     | 预览安全名单只有 png / jpeg / gif / webp / pdf；名单外一律 `Content-Disposition: attachment` + `nosniff`（验收口径第 21 条） |
| **SVG 不在名单里**               | 它是能带脚本的 XML，浏览器会当文档跑 —— 与办公文件同一类破口，只是更隐蔽                                                     |
| PDF 预览不给 `allow-same-origin` | 分享页用空 `sandbox` 的 iframe（08 §7.4）                                                                                    |
| 分享页 CSP                       | `default-src 'none'` 起步，只开 script/style/img/connect/frame(blob:)；无 `unsafe-eval`、无外域、`frame-ancestors 'none'`    |
| 失效页不泄露元数据               | `describe()` 在非 active 时**只回 state**；「已撤销」「已过期」「没有这个链接」三者形状一致                                  |
| 密码只挡住拿文件                 | 解锁换一次性 grant（10 分钟）；`previewable` 与解锁无关 —— 密码不因此开通办公文件预览                                        |
| 明文密码不上行                   | 接收方在浏览器里算 `sha256(shareId:password)`，服务端只比哈希（定长比较）                                                    |
| 撤销 / 到期                      | **字节立刻删**，行留一条墓碑 —— 接收方要看到「已撤销」而不是 404                                                             |

## 跑起来

```bash
EVOWORK_IDENTITY_PUBLIC_PEM="$(cat identity-public.pem)" \
EVOWORK_SHARE_DB=./share.db \
EVOWORK_SHARE_DIR=./share-blobs \
EVOWORK_SHARE_ORIGIN=https://s.example.com \
EVOWORK_SHARE_WEB_DIR=../../apps/web/dist \
EVOWORK_SHARE_PORT=8790 \
pnpm --filter @evowork/share start
```

`EVOWORK_SHARE_WEB_DIR` 指向 `apps/web` 的构建产物时，分享页与 API **同源**，省掉一层 CORS。
开发期可以不给它，单独跑 `pnpm --filter @evowork/web dev` 并设 `VITE_SHARE_ORIGIN`。

**默认只听 `127.0.0.1`**（与 identity 一致），前面该有一层反代。确实要直接对外时显式设
`EVOWORK_SHARE_HOST=0.0.0.0`。2026-09-27 之前是 `listen(port)` 不给地址，等于听所有网卡。

**公钥没给、或给了但用不了，都不启动**（以退出码 1 结束）：

| 情况                  | 日志                                        | 为什么不能放它起来                                                       |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| 没给                  | `share.boot.no_public_key`                  | 验不了上传者 = 任何人都能往这里塞文件；**不降级成「不鉴权」**            |
| 解析不了              | `share.boot.bad_public_key` · `unparseable` | 进程健康、端口在听，**每个合法上传都被 401**，在外面与「令牌不对」分不开 |
| 不是 P-256 的 EC 公钥 | 同上 · `not-es256`                          | 同上：每次验签都失败                                                     |
| 给的是私钥            | 同上 · `private-key`                        | 它其实验得过，但签发密钥不该出现在只验签的机器上                         |

第二行不是假设：2026-09-27 部署时 systemd 的 `EnvironmentFile` 把不带引号值里的 `\n`
吃成了 `n`，所有上传静默 401 而服务一切正常。**用 systemd 部署时公钥那一行要用单引号包住**：

```ini
EVOWORK_IDENTITY_PUBLIC_PEM='-----BEGIN PUBLIC KEY-----\nMFkw…\n-----END PUBLIC KEY-----'
```

体检本身在 `@evowork/account` 的 `checkEs256PublicPem`，网关验 JWT 时也该用它（见 §还缺什么）。

## 还缺什么

1. **本机侧的调用方**：`createShare` / `createUploader` 至今没有调用方，
   桌面产物卡上的「分享」按钮还到不了授权模态（status.md §6.1 的 D 项）。
   服务端就绪之后，这一段是接线而不是设计。
2. **`evowork://share/<id>`** 的深链处理（02 §8）：分享页上的「在 EvoWork 中打开」
   已经指过去了，桌面侧还没注册这个协议。
3. **对象存储**：现在字节落本地磁盘。云上部署要换成对象存储，
   `ShareBlobs` 这个接口就是为换它留的。
4. **网关有同一类缺陷**：`services/gateway/src/main.ts` 读 `EVOWORK_JWT_PUBLIC_PEM` 时只查
   「有没有」，公钥坏了照样起来、`hosted` 模式下每个请求静默 401；而且它不做 `\n` 还原，
   单行公钥在那边直接就是坏的。修法是启动时同样过一遍 `checkEs256PublicPem`。
5. **不在 `scripts/build.mjs` 的打包清单里**：`pnpm run build` 不产出 `dist/share/main.js`，
   部署时要手工 esbuild（参数与 identity 那一条相同）。
