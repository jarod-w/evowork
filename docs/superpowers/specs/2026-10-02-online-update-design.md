# 在线升级：没有 Apple 证书时能做什么、不能做什么

> 2026-10-02 起草。**状态：Q46 已决策（2026-10-02，六条都按 B1 的建议采纳），其余动作尚未实施。**
> 关联：[build-and-deploy §5.3](../../build-and-deploy.md) · [总纲 D9 / K6 / R10](../../evowork-on-codex-design.md) · [11 §13.4（Q30）](../../design/11-account-and-models.md) · [status.md](../../status.md) 的 U4 / U6 · [electron-builder.yml](../../../build/electron-builder.yml)
> 已回写：总纲 §10.1.8（Q46）· 总纲 D9「K6 登记：在线升级检查与下载」· CLAUDE.md §8 · build-and-deploy §5.3。以后以总纲为准，本文只保留推导与做法。

## 0. 结论

- **能做**：所有与签名无关的升级正确性工作；「手动检查 → 应用内下载并校验 → 用户自己替换」的半自动升级；发布源与清单签名；用自签证书在内部把完整的自动升级链路跑通。
- **不能做**：对外用户的自动安装、公证、首次安装时不弹 Gatekeeper 提示。
- **最该先做的一件事**：修迁移器的降级缺陷（§4 A1）。它已经复现：用户装回旧版本之后再升级，**应用打不开**。没有自动更新时，用户手动装包反而更频繁，所以这个问题比自动更新本身更急。

| 编号 | 动作 | 建议 | 优先级 |
|---|---|---|---|
| A1 | 迁移器降级时拒绝启动 | ✅ **已完成**（2026-10-02；降级提示条留到 B4） | P0 |
| A2 | 升级兼容测试（老数据 + 新代码） | ✅ **已完成**（2026-10-02；顺带修了一个真缺陷，tag 待确认） | P0 |
| A3 | 真机验证手动升级路径（钥匙串 / 数据） | ⏸ **暂缓**（2026-10-02 用户决定；步骤已写好） | P0 |
| A4 | 办公运行时加版本戳 | ✅ **已完成**（2026-10-02；界面留到 B4 原型） | P1 |
| B1 | 定 Q46，登记出网路径 | ✅ **已完成**（2026-10-02） | — |
| B2 | 发布源与发布脚本 | ✅ **已完成**（2026-10-02，更新源已上线；还没发过版本） | P1 |
| B3 | 自己给更新清单签名 | ✅ **工具与验签已完成**（2026-10-02）；密钥待发版的人生成 | P1 |
| B4 | 设置 → 关于里加「检查更新」 | **做** | P1 |
| D1 | 自签代码签名证书 spike | ⏸ **暂缓**（2026-10-02 用户决定） | P1 |
| C1 | 自建不依赖签名的自动替换更新器 | **不做** | — |
| C2 | ad-hoc 签名加显式 DR | **默认不做**，仅在 A3 结果很差时作为实验 | — |

---

## 1. 现状（2026-10-02 核对）

| 项 | 状态 | 依据 |
|---|---|---|
| 更新源配置 | 已就位（2026-10-02 起地址是 `https://update.nucleant.cn:9443/${channel}`，此前是占位符） | [electron-builder.yml:97](../../../build/electron-builder.yml#L97)：`provider: generic`，`url: https://updates.evowork.example/${channel}`。`${channel}` 宏可用（app-builder-lib 26.15.3 的 `macroExpander.js`：`appInfo.channel \|\| "latest"`） |
| 更新清单与差量文件 | 打包时已经生成 | `dist/release/` 下有 `latest-mac.yml`、`*.zip.blockmap`、`*.dmg.blockmap`（0.0.4） |
| mac 打包目标 | dmg + zip | 自动更新要用 zip，已经包含 |
| 客户端更新代码 | **没有** | `apps/desktop/package.json` 没有 `electron-updater` 依赖，主进程里没有更新模块 |
| 服务端 | **没建** | build-and-deploy §5.3 |
| 签名 | ad-hoc | `codesign -d -r-` 输出 `designated => cdhash H"4844e9ce…"`，`Signature=adhoc`，`TeamIdentifier=not set` |
| Info.plist | 没有 `LSFileQuarantineEnabled` | `plutil -p …/Info.plist` |
| 版本 tag | 只有 `v0.0.1`、`v0.0.2` | 0.0.3（`312f1a2`）与 0.0.4（`916a5f7`）只有改版本号的提交，没打 tag |
| 版本号展示 | 设置 → 关于 | [settings.tsx:973](../../../apps/desktop/src/renderer/views/settings.tsx#L973) `AboutSection` |
| 可用 UI 组件 | 够用，不用新增 | 01 §5：TipBanner（5.29）· Toast（5.31）· ProgressBar（5.33）· Dialog（5.34） |

---

## 2. 根因：ad-hoc 签名让每个版本都成了「另一个应用」

ad-hoc 签名没有证书。它的 designated requirement（DR，系统用来判断「这是不是同一个应用」的规则）就是 `cdhash`，也就是整个包内容的哈希。**每次构建 cdhash 都会变**，所以在系统看来，0.0.4 和 0.0.3 不是同一个应用。

后果如下。**这些问题今天的手动升级就已经会碰到**，并不是自动更新才引入的：

| 受影响的地方 | 表现 | 依据 |
|---|---|---|
| Squirrel.Mac（electron-updater 在 mac 上的安装器） | 自动安装失败：它要求新包满足正在运行的应用的 DR，而 cdhash 每次都不同 | Electron 官方文档写明 mac 自动更新必须签名。**本文没有实际跑过** |
| 钥匙串（`safeStorage`，Q34） | 升级后可能弹框要登录密码，也可能读不出来，表现成「密钥没了」 | 推断，**没验过**（属于 U6） |
| TCC（Computer Use 的辅助功能和录屏授权） | 升级后可能要重新授予 | 推断，**没验过**。Computer Use 目前还不可用，暂时不影响用户 |
| App 管理保护（macOS 13+） | 一个应用去改写另一个应用的包时，系统会要求「App 管理」权限 | 平台已知行为。只影响 C1 那种自己替换应用包的做法 |
| Gatekeeper 首次启动 | 浏览器下载的包带 quarantine 标记，用户要先清标记才能打开 | 已知，见 [scripts/adhoc-sign.mjs](../../../scripts/adhoc-sign.mjs) 的头注释 |

---

## 3. 不能做的（等证书）

| 项 | 为什么做不了 | 证书到了之后 |
|---|---|---|
| 对外用户的自动安装 | Squirrel.Mac 需要稳定的 DR；ad-hoc 签名给不了 | 接 electron-updater，退出时安装 |
| 公证 | 必须用 Developer ID | 打包流水线里加公证 |
| 首次安装不弹 Gatekeeper | 没有公证，系统就会拦 | 公证后自然解决 |
| 对外用户升级后钥匙串 / TCC 授权不丢 | 需要基于 Team ID 的稳定 DR | 换成 Developer ID 签名后，会有**一次性**的重新授权，之后就稳定了 |
| 由系统签名保证更新包的真实性 | 同上 | B3 的清单签名可以保留，作为额外一层 |

Windows 不在本文范围（Q26 macOS 首发；U5 还没结论）。

---

## 4. 能做的，以及怎么做

### A1 · 迁移器降级时拒绝启动（P0，✅ 2026-10-02 已完成）

**问题**：[migrate.ts:227-235](../../../services/store/src/migrate.ts#L227-L235) 的 `applyMigrations` 只会往前跑迁移。数据库版本比应用新的时候，它一条也不执行，却在 [第 371 行](../../../services/store/src/migrate.ts#L371) 把版本号写成了应用的（更低的）版本。投影库那边（[第 283-292 行](../../../services/store/src/migrate.ts#L283-L292)）也是同样的写法。

**复现**（2026-10-02，用 esbuild 打包后直接调用 `migrateAuthoritative`，假设下一版 v4 给 `automation` 加了一列）：

```
① 新版本启动后 schema_version = 4
② 装回旧版本启动后 schema_version = 3  applied = []
③ 再升级：失败 -> AuthoritativeMigrationFailed / duplicate column name: note
```

也就是说，用户装回旧包之后再升级，**应用就打不开了**。触发场景包括：手动装了一个旧 dmg；将来从 beta 渠道切回 stable 渠道。

**怎么做**：
- 权威库：`from > target` 时抛一个专门的错误（比如 `SchemaNewerThanApp`），**不写版本号**。宿主据此显示原因页：「这份数据来自更新的版本 vX，请安装 vX 或更新的版本」，同时给出 `.bak.<version>` 备份所在的路径。不静默降级。
- 投影库：投影是可以重建的，所以 `from > target` 时直接按当前 schema 重建，不要只改版本号。
- 再加一个不阻塞启动的提示：在 meta 表里记下 `last_app_version`。当前版本比它旧时，用 TipBanner 提示「你装回了旧版本，部分任务历史可能无法打开」。原因是内核自己的 rollout 和 sqlite 不一定向后兼容，而这一层我们看不到（K2）。
- 测试：把上面的复现写进 `services/store/test/migrate.test.ts`。断言要写后果，不写实现，例如：「装回旧版本不许改写版本号，否则再升级时同一条迁移会重跑，应用打不开」。

**落地情况（2026-10-02）**：

- 两个迁移器按上面做了。设计改动写在 [09 §4.6](../../design/09-service-layer.md)，进度写在 [status.md](../../status.md)。
- 「原因页」实际做成了**系统错误对话框**（`dialog.showErrorBox`，经新的端口成员 `showErrorBox`），文案在 `apps/desktop/src/main/startup-failure.ts`。这样做是因为启动失败时渲染层还没有可用的服务，而且此前没有任何启动失败的界面。文案**没写备份路径**：这条路径不改库，所以不产生备份。
- `last_app_version` 已经记下，但现在只用来说「该装哪一版」。**「你装回了旧版本」的提示条没做**：它是新的渲染层界面，按惯例要先出原型，留到 B4 和「检查更新」的原型一起做。
- 只有新旧两个版本都带着这个修复时才生效：0.0.4 及更早的版本装回来，仍会把版本号写低。

### A2 · 升级兼容测试（P0，✅ 2026-10-02 已完成）

**问题**：没有任何测试在「老版本留下的 `~/.evowork` + 新版本代码」上跑过。[status.md](../../status.md) 里也记着：「`title_source` 的迁移只在测试里跑过，没在真实老库上验过升级」。

**怎么做**：
1. 先给 0.0.3、0.0.4 补 tag（`312f1a2`、`916a5f7`；要先确认这两个提交就是实际发出去的版本）。以后每次发版都打 tag，写进发布脚本的前置检查（B2）。
2. 用每个已发版本造一份夹具：该版本的 `evowork.db`、内核的 `config.toml`、`app.toml`。放在 `apps/desktop/test/fixtures/upgrade/v0.0.x/`。
3. 测试：在每份夹具上启动当前版本的服务宿主，断言**用户数据还在**（automation 定义、项目、任务标题），而且 config 迁移（`migrateMultiAgentV2Config` 这一类）是幂等的。
4. 守卫要判包含关系，不判具体名字（CLAUDE.md §9.1）：断言「`AUTHORITATIVE_MIGRATIONS` 里出现过的每个版本都有对应夹具」。以后新增一条迁移却忘了加夹具，测试同样会红。

**落地情况（2026-10-02）**：

- **夹具**：`scripts/build-upgrade-fixture.mjs` 用那个版本自己的 `openStore` 建库（`git archive` 取旧代码，不动工作树），每张表写一行固定样例。已生成 0.0.1 到 0.0.4 四份。原计划要在每份夹具上启动整个宿主，但那需要真内核，进不了 `pnpm run check`；所以改为直接测宿主启动时会跑的两段：`openStore`，以及从宿主里抽出来的 `migrateKernelConfigText`。宿主现在调用的就是这个函数，测试跑的和宿主跑的是同一串。
- **第 4 条守卫改了判据**：没有任何发出去的版本停在权威表 v2（0.0.1 是 v1，0.0.2 已经是 v3），所以「每个 schema 版本都有夹具」本身就是错的。改成「**当前版本号一定有一份夹具**」：发版时版本号改上去，测试就会红，直到那一版的夹具生成出来。
- **新增两条判一类的守卫**：升级后的表结构与全新安装逐列相同，拦的是改了建表语句却没写迁移；当前模板的每个根键，老配置迁移后都有。两条都做过反向核对。
- **当场抓到的缺陷**：0.0.1 / 0.0.2 装出来的内核配置缺根键 `default_permissions`。在真内核上，`config/read`、`plugin/list`、`experimentalFeature/list`、`mcpServerStatus/list` 都回 -32603，插件页因此是空的。修法是新的配置迁移 `migrateDefaultPermissions`，修完在真内核上 13 个方法全部正常。细节见 [status.md](../../status.md)。
- **没覆盖**：`app.toml`、`models.toml`。它们由运行时代码写出，模板里没有，夹具生成不了。
- **第 1 条（补 tag）没做**：打 tag 是要推到远端的操作，需要发版的人确认这两个提交。

### A3 · 真机验证手动升级路径（P0，⏸ 2026-10-02 暂缓，需要人在真机上操作，约半天）

目的是把 §2 里的几条推断变成事实，结论写回 status.md 的 U6。

| 步骤 | 记录什么 |
|---|---|
| ① 装 0.0.3，添加一个自定义模型（密钥进钥匙串），建一个 automation | 首次加密时有没有弹钥匙串框 |
| ② 退出，用 0.0.4 的 dmg 拖拽覆盖，启动 | 弹没弹钥匙串框？选「允许」之后密钥能不能读出来？选「拒绝」时界面怎么说（应该是「请重新填密钥」，不能崩） |
| ③ 检查 automation、任务列表、项目 | 数据是否完整 |
| ④ 再装回 0.0.3 | 现在两版之间的 schema 版本号相同，A1 不会触发。只看能不能启动 |

**结论决定后续怎么处理**：如果每次升级都弹钥匙串框，那么在证书到手之前，发版说明和升级界面都要**提前讲清楚**（「升级后系统会询问钥匙串访问，请选择『始终允许』」），这是「不静默降级」纪律的要求。如果直接读不出来，就优先做 D1。

**照着做的步骤（2026-10-02 补）**。本机没有 0.0.3 的安装包，但这个测试不需要两个不同的版本号，只需要**两个不同的构建**：每次构建的 cdhash 都不同，系统就会把它们当成两个应用。所以用 `dist/release/` 里现成的 0.0.4 当「旧版」，用当前分支新打的包当「新版」，新版里正好带着 A1 的修复。

数据目录用 `EVOWORK_HOME` 挪到一个临时目录，不碰你平时的 `~/.evowork`。但**钥匙串项是按应用分的，不按数据目录分**：如果这台 Mac 上平时就在用 EvoWork，第 ② 步会碰到它真实的那一项。最干净的做法是换一个 macOS 测试账号来做。

```bash
# ① 先把现成的 0.0.4 留一份：第 ③ 步重新打包会覆盖 dist/release/
mkdir -p ~/evowork-a3 && cp dist/release/EvoWork-0.0.4-mac-arm64-unsigned.dmg ~/evowork-a3/old.dmg

# ② 装「旧版」：挂载 old.dmg，把 EvoWork 拖进「应用程序」，然后
xattr -dr com.apple.quarantine /Applications/EvoWork.app
EVOWORK_HOME=$HOME/evowork-a3/home /Applications/EvoWork.app/Contents/MacOS/EvoWork
#    设置 → 模型 → 添加模型（key 随便填，如 sk-test-1234）；再建一个定时任务；退出

# ③ 打「新版」并覆盖安装（这一步可以让 Claude 来跑）
pnpm run build && pnpm run package
#    挂载新的 dmg，拖进「应用程序」覆盖，然后
xattr -dr com.apple.quarantine /Applications/EvoWork.app
EVOWORK_HOME=$HOME/evowork-a3/home /Applications/EvoWork.app/Contents/MacOS/EvoWork

# ④ A1 的真机验证：把库伪造成「更新版本写的」
sqlite3 ~/evowork-a3/home/evowork.db "UPDATE meta SET value='99' WHERE key='schema_version_authoritative'"
EVOWORK_HOME=$HOME/evowork-a3/home /Applications/EvoWork.app/Contents/MacOS/EvoWork
#    应该弹出「EvoWork 无法打开」，点掉之后应用退出
sqlite3 ~/evowork-a3/home/evowork.db "UPDATE meta SET value='3' WHERE key='schema_version_authoritative'"

# ⑤ 清理
rm -rf ~/evowork-a3   # 钥匙串里的「EvoWork Safe Storage」：只有这次测试才新建的才删
```

每一步要记下来的：

| 步骤 | 记录什么 |
|---|---|
| ② 第一次保存 key | 弹没弹钥匙串框 |
| ③ 新版第一次启动 | 弹没弹「EvoWork 想要使用钥匙串中的机密信息」？选「允许」后，设置页里那条模型的 key 后四位还在不在？另做一次选「拒绝」，界面怎么说（应该是「请重新填密钥」，不能崩） |
| ③ 数据 | 定时任务、任务列表、项目都还在不在 |
| ④ | 对话框的文案、点掉之后是不是真的退出；改回 3 之后能不能正常打开 |

### A4 · 办公运行时加版本戳（P1，✅ 2026-10-02 已完成，界面未接）

**问题**：[runtime.ts:41](../../../services/ingest/src/runtime.ts#L41) 和 [第 185-187 行](../../../services/ingest/src/runtime.ts#L185-L187) 判断「装没装」只看能不能 import 那几个模块。新版本改了 [manifest.ts:112-117](../../../services/runtime-installer/src/manifest.ts#L112-L117) 的钉死版本时，旧环境仍然被判成「已安装」，过期了也发现不了。

**怎么做**：
- 安装器在原子换入那一步写一个 `~/.evowork/runtime/office/.evowork-runtime.json`，内容是 manifest 摘要（python 版本 + 六个包的版本 + 字体哈希）。
- 探测时比对这份摘要：不一致就判为「需要更新」，这是和「未安装」不同的状态。用 TipBanner 提示，**由用户点击后才重新安装**。D9 的 K6 登记写的是「只有用户点安装时才出网」，这里不能改成自动下载。
- 没有版本戳的老安装：同样判为「需要更新」，但不阻塞使用。

**落地情况（2026-10-02）**：

- 版本戳、`runtimeStampStatus()`、`RuntimeStatusView.outdated` 都已经做了，在线和离线两条安装路径都会写戳。
- 用户自己指定了解释器（`EVOWORK_OFFICE_PYTHON`）时不判：那份运行时由企业负责。
- **TipBanner 没做**：它是新的界面状态，要先出原型，留到 B4 一起做。所以这一步目前对用户不可见。

### B1 · 定 Q46，登记出网路径（✅ 2026-10-02 已决策并回写总纲 §10.1.8 与 D9）

「用户显式触发的请求可以发，自动或后台发起的不行；打开自动拉取的开关本身就是显式授权」这条规则，**2026-10-02 已由 HUB-Q3=B 写进总纲 §10.1.4 的 Q30**。Q46 直接引用它，不再另立。Q46 只决定在线升级特有的几件事：

| 场景 | 建议 |
|---|---|
| 用户在设置 → 关于里点「检查更新」 | 允许，登录与否都行（Q30 的显式触发） |
| 已登录时自动检查 | 允许，每天最多一次 |
| 未登录时自动检查 | **默认关闭**；设置里给一个独立开关，不和 Hub 的「未登录时也获取 EvoWork 精选内容」（13 §5.6）合并 |
| 检查到新版本之后 | 只提示，不自动下载。证书到手、改成自动安装时，下载前仍然先问用户 |
| 强制更新 | **不做**。本机执行面永远不因为版本旧而停用；云端服务可以拒绝过旧的客户端，并说明「需要更新 EvoWork 才能使用登录 / 托管模型」 |
| 企业 | 照 HUB-Q11=A 的做法：策略包里加 `disableUpdateCheck` 开关；环境变量 `EVOWORK_UPDATE_FEED`（`off` 或内网镜像地址）由 MDM 下发；离线企业自己分发安装包。暂不做锁版本 |

**请求里带什么**：只发 GET 拉清单和清单签名。**不带 `deviceId`，也不带账号令牌**（已登录时同样不带），和 13 §4.4「拉官方源一律不带账号令牌」是同一个口径。版本比较放在客户端做，所以请求里连版本号都不必带。这样一次更新检查就关联不到某个账号。

要登记进 D9 的出网表：触发条件、目的地、请求内容、不联网时的表现。D4 验收（`acceptance.real.spec.mjs`）不会触发手动检查，所以不用改。如果以后打开「已登录时自动检查」，D4 只在已登录的场景里放行更新域名。

### B2 · 发布源与发布脚本（P1，做）

> **2026-10-02 决定**（采纳下面的建议）：试点阶段**沿用现有服务器**（115.190.115.161 的 Apache；它的 `/var/www/html` 现在就在提供安装包下载），加一个子域名和 Let's Encrypt 证书改成 HTTPS。用户量上来以后再迁到对象存储 + CDN，客户端只认一个地址，迁移只改配置。上传权限是那台服务器的 ssh key，**只放在发版机上**。
> **域名（2026-10-02 给定，试点期）**：`https://update.nucleant.cn:9443/`，已写进 `build/electron-builder.yml` 的 `publish.url`。
> **已上线（2026-10-02 当天搭好，搭法见 [build-and-deploy §5.3.1](../../build-and-deploy.md)）**。下面是搭之前的只读核对结果，留作记录：
> - 公共 DNS 对 `update.nucleant.cn` 返回 NXDOMAIN，还没有 A 记录。同一服务器上的 `demo.nucleant.cn`、`admin.nucleant.cn` 解析到 115.190.115.161。
> - 9443 端口上没有进程在监听；ufw 放行了 9943、9944，**没有放行 9443**。
> - 服务器上 Apache 在跑，只监听 80；nginx 里那两份 9943/9944 的配置没有生效（nginx 是 inactive）。
> - 现有证书 `/etc/ssl/nucleant/demo.nucleant.cn.crt` 是**自签名**的，客户端不会信任它。服务器上没有 certbot 或 acme.sh。

**发布源**：
- HTTPS 域名 + 对象存储 + 国内 CDN。按 build-and-deploy §5.3 的规划，可以和办公扩展共用一个桶，分两个前缀。
- **现在的 115.190.115.161 是明文 80 端口，不能当更新源**：中间人可以同时替换清单和安装包。B3 能拦住，但 HTTPS 不能省。
- 外部前置条件：域名备案（11 §10.1 已经列过）。

**目录结构**：

```
/{channel}/latest-mac.yml
/{channel}/signatures/<清单的 sha256>.sig ← B3：按内容命名，旧的从不删
/{channel}/EvoWork-x.y.z-mac-arm64-unsigned.{zip,dmg}
/{channel}/EvoWork-x.y.z-mac-arm64-unsigned.{zip,dmg}.blockmap
```

**发布脚本**（`scripts/publish-release.mjs`）：
- 前置检查：工作树干净（参见 memory 里「多会话共用一棵工作树」那条）· 有 tag 且和 `package.json` 版本一致 · 版本号大于线上的版本 · `verify-packaged-app.mjs` 通过 · `KERNEL_PROVENANCE.json` 与 `patches/evowork/` 一致。
- 上传顺序：**先传安装包和 blockmap，再传 `.sig`，最后传 `latest-mac.yml`**。顺序反了，用户会拿到一份指向还没上传完的文件的清单。
- 线上的旧版本不删，出问题时要能对照。

**落地情况（2026-10-02）**：`scripts/publish-release.mjs` 已经做了，**还没有真的发过**：域名没定，服务器上的 vhost 和证书也还没配。

- 目标先只认一个路径：本地目录，或 `user@host:/路径`（rsync over ssh）。`--dry-run` 只做检查、不签名、不上传。
- 检查八项：工作树干净 · HEAD 打了 `v<版本>` 的 tag · 清单版本与 `package.json` 一致 · 清单里每个文件都在、大小与 sha512 对得上 · 有这一版的升级兼容夹具 · 客户端内嵌了日常与备用两把公钥、签名用的 kid 在其中 · **打包产物里真的嵌着这把 kid**（源码里有不等于打出来的包里有）· 比线上的版本新。任何一项不过，一个文件都不传。
- 和上面计划的两处不同：
  - `verify-packaged-app.mjs` 会真的启动应用，所以不替人跑，只提醒。
  - `KERNEL_PROVENANCE.json` 的核对在打包那一步（`package.mjs`）就做了。发布这一步改成核对 sha512 和嵌入的 kid，确认要发的就是那次打包的产物。
- **签名文件改成按清单内容命名**（`signatures/<sha256>.sig`），原计划是 `latest-mac.yml.sig`。同名覆盖时，两次上传之间拉到「新清单 + 旧签名」的客户端会验签失败，CDN 缓存还会把这个窗口拉长；按内容命名之后，拿到哪份清单就取哪份签名，没有这个窗口。
- 在真仓库上跑 `--dry-run`：查出 4 项不过（工作树、tag、公钥、包里的 kid），另外 4 项通过，其中两个 223MB 安装包的 sha512 都对得上。

### B3 · 自己给更新清单签名（P1，做）

> **2026-10-02 决定**（采纳下面的建议）：私钥**只放在发版机上**，不进 CI。客户端内嵌**两把**公钥：一把日常用；另一把备用，它的私钥离线单独保管，只在日常那把丢失或泄露时启用。
> **目前只有一个人发版**（2026-10-02 确认）。
> **密钥已在发版机上生成**（2026-10-02，发版的人授权直接操作）：日常 `evowork-update-1` 存在登录钥匙串（service `evowork-update-signing`）；备用 `evowork-update-backup-1` 写在 `~/evowork-update-backup-key/`（0600），**要挪到离线位置并删掉本机副本**。两把公钥已写进 `update-keys.ts`。实测：从钥匙串取出日常私钥签名、从文件取出备用私钥签名，两份签名都被客户端的 `verifyUpdateManifest` 验过。

**为什么必须做**：`latest-mac.yml` 里的 sha512 和安装包放在同一台服务器上，只能证明文件没传坏，证明不了文件是我们发的。没有 Developer ID 时，系统签名也帮不上忙。另外 B4 用应用内下载，下载下来的文件不带 quarantine 标记（§7 实测），Gatekeeper 不会检查它。所以**清单签名是唯一的真实性校验**，不是锦上添花。

**怎么做**：
- 复用 `packages/account` 的签名原语（ES256，P1363 编码）。沿用 [policy-pack.ts](../../../packages/account/src/policy-pack.ts) 的做法：**签原文，验原文**，不要两边各自序列化一次。
- 公钥在构建时编进应用，内嵌两把（当前一把 + 下一把，带 `kid`），留出换钥的余地。私钥离线保管，发布时才用。
- 客户端：先验 `.sig`，通过之后才相信清单里的版本号和 sha512；下载完再校验 sha512。任何一步失败都整包丢弃，并如实告诉用户原因。

**落地情况（2026-10-02）**：

- `scripts/update-signing.mjs`：`keygen` 生成 P-256 密钥。日常那把默认存进登录钥匙串，`--out` 写成 0600 的 PEM 文件，给备用那把用；两处都不覆盖已有的 key。`sign` 签名后先自验一遍，再写进 `signatures/<sha256>.sig`。
- 客户端：`apps/desktop/src/main/update-manifest.ts` 的 `verifyUpdateManifest`，失败分四种：`no-keys` · `malformed-signature` · `unknown-key` · `bad-signature`。公钥表在 `update-keys.ts`，**现在是空的**：私钥要由发版的人在发版机上生成，生成命令写在那个文件的头注释里。
- 和上面计划的不同：**没有复用 `packages/account`**。签名端是 `.mjs` 脚本，引不了 TS 包，所以两边都直接调 `node:crypto`，参数相同。两边对不对得上，由 `scripts/test/update-signing.test.mjs` 守着：用真的签名函数签，用真的验签函数验。这条测试还覆盖了这些情况：清单被改一个字、别人的 key 冒用我们的 kid、DER 编码的签名、两边算出的签名文件名不一致。

### B4 · 设置 → 关于里加「检查更新」（P1，做）

**流程**：

```
点「检查更新」→ 拉 yml → 按它的 sha256 取 signatures/<sha256>.sig → 验签 → 和 app.getVersion() 比较
  ├ 已是最新 → Toast
  └ 有新版本 → 显示版本号与更新说明（纯文本渲染）+ [下载]
        → 应用内下载 dmg（ProgressBar；60 秒收不到字节就判断连接已断，给出可照做的原因）
        → 校验 sha512
        → [退出并打开安装包]：先检查有没有进行中的任务 / 正在执行的 automation / 正在安装的办公扩展，
          有的话用 Dialog 列出会被打断的内容，让用户确认
        → 打开 dmg，退出应用，由用户把新版本拖进「应用程序」
```

**落位**：
- 主进程新增 `apps/desktop/src/main/update-check.ts`，渲染层只通过 IPC 拿到视图数据。频道名放进共享常量表，不手写字面量，这有 `bootstrap.test.ts` 守着。
- 下载器：runtime-installer 在 K6 登记里是「唯一为装扩展而出网的包」，不要直接借用它，以免改了它的登记含义。停滞检测这类经验可以照搬；如果最后两处代码一模一样，再抽成共用函数。
- UI 先出原型再写代码（团队惯例），用仓库里真实的 token 画。所有组件都在 01 §5 清单里，不用新增。
- **不做**：启动时自动检查（Q46 允许之前）、自动下载、自动安装。

**这一步以后能复用多少**：发布源、清单、签名、界面状态都可以继续用。证书到手之后，只需把「打开 dmg 让用户自己拖」换成 electron-updater 的「退出时安装」。

### D1 · 自签代码签名证书 spike（P1，⏸ 2026-10-02 暂缓）

**设想**：用一张自签的代码签名证书（钥匙串访问 → 证书助理就能生成）代替 ad-hoc 签名。这样 DR 就变成 `identifier "com.evowork.desktop" and certificate leaf = H"…"`：它绑定的是我们的私钥，不再随每次构建改变。

**如果成立，能得到三样东西**：
1. 在内部把 electron-updater + Squirrel.Mac 的完整自动安装链路跑通。证书到手后，只需换一下签名身份。
2. 给内测用户发包时，升级后 TCC 授权可能不再丢失（推断）。
3. 钥匙串**不一定**能跟着解决：钥匙串项还有一层 partition list，它怎么对待没有 Team ID 的签名，我没把握，必须实测。

**和 C2 的区别**：C2 只按 identifier 匹配，谁都能冒充；这里绑定了证书，没有私钥就冒充不了。

**依然不变的**：首次安装仍然要清 quarantine，因为自签证书不被 Gatekeeper 信任。所以这只适合内测和试点，**不能作为对外正式发布的方案**。

**怎么验**：
- 在 [after-pack.mjs](../../../scripts/after-pack.mjs) 里加一条分支：设置了 `EVOWORK_SELF_SIGN_IDENTITY` 时，用这个身份签名，否则照旧 ad-hoc。
- 签两个版本号不同的包，在本机起一个静态 HTTP 服务当更新源，让旧版本自动升级到新版本。
- 看三件事：Squirrel 能否通过校验；升级后钥匙串弹不弹框；用 `tccutil` 或系统设置看授权是否保留。
- 当前 entitlements 已经包含 `disable-library-validation`，所以开 hardened runtime 也不会卡在库校验上。
- 结论写回本文。成立的话，「内测包换成自签证书签名」作为一项决策单独拍板。

### C1 · 自建不依赖签名的自动替换更新器（不做）

做法类似 Sparkle：下载 zip，验我们自己的签名，用一段辅助脚本替换 `/Applications/EvoWork.app`。不做的理由：
- 证书一到就作废。
- 替换正在运行的应用包、处理 `/Applications` 的写权限、失败回滚，这些都要自己写，而且每一项都要在真机上验。
- macOS 13+ 的「App 管理」保护会弹授权框。
- 它解决不了 §2 里钥匙串和 TCC 的问题，因为 cdhash 仍然每次都变。

### C2 · ad-hoc 签名加显式 DR（默认不做）

做法是 `codesign -s - -r='designated => identifier "com.evowork.desktop"'`。理论上能让 Squirrel、钥匙串、TCC 把后续版本认成同一个应用，但**任何人都能用同一个 identifier 做一次 ad-hoc 签名**，冒充者就能免弹框读走那一项钥匙串，Q34 的保护会被实质削弱。D1 能拿到同样的好处而没有这个漏洞，所以只有 D1 走不通、而 A3 的结果又很糟时才考虑它，上线前要先把这个取舍写进文档。

---

## 5. 建议的顺序

工作量是粗估。

| 顺序 | 内容 | 粗估 | 依赖 |
|---|---|---|---|
| 1 | ~~A1 迁移器~~ | ✅ 已完成 | — |
| 2 | ~~A2 升级夹具测试~~ | ✅ 已完成；补 tag 仍待确认 | 确认 0.0.3/0.0.4 对应的提交 |
| 3 | A3 真机验证 | ⏸ 暂缓 | 需要人和一台 Mac |
| 4 | D1 自签证书 spike | ⏸ 暂缓 | 结果决定内测包怎么签 |
| 5 | ~~B1 Q46 + 出网登记~~ | ✅ 已完成 | — |
| 6 | ~~A4 运行时版本戳~~ | ✅ 已完成（界面留到 B4 原型） | — |
| 7 | ~~B2 + B3 发布源、发布脚本、清单签名~~ | ✅ 已完成：更新源已上线，密钥已生成；还没发过版本 | — |
| 8 | B4 检查更新（原型 + 实现） | 0.5 + 2 天 | B1、B2、B3 |

1–4 不依赖任何外部条件，现在就能开始。

## 6. 待决策

| # | 问题 | 建议 |
|---|---|---|
| ~~Q46~~ | 在线升级特有的边界：已登录时的自动检查、未登录时的开关、检查到之后做什么、强制更新、企业管控。「显式触发」规则引用 Q30，不另立 | ✅ 2026-10-02 按 §4 B1 的建议采纳，见总纲 §10.1.8 |
| — | 内测包是否改用自签证书签名 | 等 D1 的结果 |
| — | 0.0.3 / 0.0.4 补 tag 用哪两个提交 | `312f1a2` / `916a5f7`，需要发版的人确认 |
| — | 更新源的域名（及是否已备案）；私钥保管 | 私钥保管 ✅ 2026-10-02 定（B3）。**域名仍待定**，和 identity 的正式域名一起定 |

## 7. 本文的验证记录

**2026-10-02 实际跑过的**：

| 断言 | 怎么验的 |
|---|---|
| 0.0.4 的 DR 是 cdhash | `codesign -d -r- dist/release/mac-arm64/EvoWork.app` |
| `${channel}` 宏可用 | 读 `app-builder-lib/out/util/macroExpander.js` |
| Info.plist 没有 `LSFileQuarantineEnabled` | `plutil -p` |
| 用 Node `fetch` 下载的文件不带 quarantine | 本机（macOS 27）用 node 下载一个文件，`xattr -l` 只看到 `com.apple.provenance`。**这是纯 node 测的，没在 Electron 主进程里测**；而只带 provenance 的 ad-hoc 应用在 macOS 27 上能不能直接打开，也**没验过** |
| 迁移器降级后再升级会失败 | §4 A1 的复现 |
| 办公运行时只靠 import 判断有没有装 | 读 `services/ingest/src/runtime.ts` |

**没验过、只是推断或引用文档的**：Squirrel.Mac 对 ad-hoc 签名的拒绝（Electron 官方文档）· 升级后钥匙串和 TCC 的表现（A3 去验）· 自签证书能否让 Squirrel、TCC、钥匙串认成同一个应用（D1 去验）· blockmap 差量对 217MB 内核二进制的实际收益。
