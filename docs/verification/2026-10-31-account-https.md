# 2026-10-31 账号服务迁移与 HTTPS 验收

## 范围

按用户要求，等待迁移会话完成后，先独立验证 `43.143.248.70:8000`，通过后再启用
`https://account.nucleant.cn`。账号、分享、数据库及签发密钥延续迁移结果；原 Hub 和更新站点保留。
本轮未发布新版本或覆盖已安装客户端；未调用真实模型服务。此前旧服务器的账号实现验收见
[历史记录](2026-10-31-account-online.md)。

## 切换前验证

22:01:24–22:02:14（台北时间），真实 Electron、隔离 Chrome、系统钥匙串及新服务器完成：

- 真实 QQ 注册验证邮件 → PKCE 回调 → 桌面登录。
- 关闭重开客户端，从加密凭据恢复登录。
- 真实找回密码邮件 → 设置新密码 → 桌面重新登录。
- 本轮测试账号注销成功。

见 [HTTP 迁移验证结果](assets/2026-10-31-account-migration-http/result.json)。
该阶段没有重复等待正式续期计时器，HTTPS 阶段单独执行。

## HTTPS 部署及服务回归

| 检查 | 结果 |
| --- | --- |
| 域名指向新服务器 | 新服务器 DNS 解析 `account.nucleant.cn` 为 `43.143.248.70`，ACME 公网验证成功 |
| 可信 TLS | 实际 Chrome、Node 与 curl 均正常验证，不使用忽略证书选项；TLS 1.2/1.3 实握手通过 |
| 证书 | Let's Encrypt YE1；CN `account.nucleant.cn`；2026-10-31 13:05:35 UTC 至 2027-01-29 13:05:34 UTC |
| 自动续期 | `certbot.timer` active/enabled；`renew --dry-run --run-deploy-hooks` 成功，模拟签发及 Apache configtest/reload hook 完整执行 |
| HTTP 重定向 | 域名 80、新 IP 8000、旧 IP 8000 的 `/signin` 均直接 308 到 HTTPS 同路径 |
| 服务状态 | identity、share、Apache 均 active；identity/share 只监听 loopback |
| Cookie | 登录返回 `Secure; HttpOnly; SameSite=Lax`，真实浏览器有独立断言 |
| 账号接口 | health、ready、JWKS、me、catalog、quota、devices、管理员成员/模型/用量均 200；未登录 me 为 401 |
| 分享 | 上传临时样本 → 返回 HTTPS 分享链接 → 分享页/元数据/原文下载 → 撤销 204 → 再下载 404；样本已撤销 |
| 原有站点 | Hub `/v1/evowork/index.json` 和更新 `/latest/latest-mac.yml` 均 200；保持更新站点为默认 TLS vhost |

接口记录见 [endpoints.json](assets/2026-10-31-account-https/endpoints.json)。分享探针初次把撤销成功状态
误写为 200，实际服务定义为 204；按既有协议修正探针后，撤销后的下载拒绝断言通过，未修改分享服务。
管理员探针只读已有配置，退出前吊销专用测试设备；未修改管理员密码、模型配置或既有数据。

Apache 源配置为 `build/account-apache.conf` 与 `build/account-legacy-http.conf`。
证书/私钥和 SMTP 凭据均留在服务器，未进仓库。部署前 root-only 备份在
`/root/evowork-https-backup-20261031/`；旧服务器后端保持停止，保留原数据。
新服务器账号 bundle 与本机最终构建一致，SHA-256：
`6a37df6b9ab0e14a3d41614659bed48012d1276015e0a01f1544eb8e97f4e380`。

## HTTPS 桌面流程

真实 Electron 旅程 22:07:12–22:22:25（台北时间）全部通过，见
[正式计时器结果](assets/2026-10-31-account-https/result.json)。

| 阶段 | 结果 |
| --- | --- |
| 注册 → QQ 实际收件 → 验证 → PKCE 桌面登录 | 通过，邮件链接为域名 HTTPS |
| 生产十五分钟 JWT 的提前自动续期 | 22:07:31.390 → 22:21:31.042，839.652 秒；access/refresh 摘要均变化 |
| 续期不重启本机网关 | PID 保持不变 |
| 关闭重开客户端 | 从系统钥匙串的加密 refresh 恢复登录 |
| QQ 重置邮件 → 新密码 → 桌面再登录 | 通过 |
| 测试账号注销 | 成功 |

真实桌面登录截图已查看。测试运行只接管系统浏览器打开动作交给隔离 Chrome，
未替换账号服务、钥匙串、网关或令牌续期实现；没有缩短线上令牌有效期。

独立 `.app` 22:22:31–22:23:51 全流程退出 0，使用包内 HTTPS 地址、网关与内核，
未注入账号地址覆盖。再次完成真实 QQ 注册/验证、PKCE、重启恢复、真实重置邮件和新密码再登录；
HTTPS Cookie 断言通过。该轮未重复等待十五分钟计时器，计时器结果以上一轮为准。
见 [packaged result.json](assets/2026-10-31-account-https-packaged/result.json)。
480px 窗口注册/登录按钮在视口内有实际断言，截图已查看；登录后的独立包截图也已查看。

三轮迁移/HTTPS 测试账号均已注销，临时家目录均在进程退出后删除；验证记录只保留阶段、时间和摘要。

## 本地构建与边界

最终完整 `pnpm run check` 退出 0：214 个测试文件通过，3463 项通过、2 项既有跳过；
格式、lint、类型、内核预算、协议形状和许可检查通过。新增 HTTP/HTTPS Cookie 行为两项回归均执行。

完整桌面构建通过，独立 `.app` 为 `dist/account-https-validation/mac-arm64/EvoWork.app`，
版本保持 0.0.8。`codesign --verify --deep --strict` 通过，签名仍是 ad-hoc。
七项包内关键产物（主进程、入口、preload、渲染入口、网关、账号配置、发货内核）与构建源
逐项 SHA-256 一致，见 [package-hashes.json](assets/2026-10-31-account-https/package-hashes.json)。

仅验 macOS arm64；U4 Developer ID/公证和 U6 三台真机验证保持未关闭。
桌面 PKCE 回调仍使用本机 loopback HTTP；云端账号请求、事务邮件链接和分享链接均为域名 HTTPS。
正式旧版已安装客户端不会因本轮构建自动替换；旧浏览器链接由服务端重定向兼容；旧版客户端的跨源请求不作为本轮验收结论。

本轮服务器实际凭据的内存比对扫描覆盖源码、证据和验证包 8536 个文件，0 命中；
见 [secret-scan.json](assets/2026-10-31-account-https/secret-scan.json)。扫描不输出实际凭据。
