# services/policy —— 安全与策略（L3）

| 项     | 值                                                                          |
| ------ | --------------------------------------------------------------------------- |
| 里程碑 | M4 安全与权限（4 人周）                                                     |
| 设计   | [10 安全 · 权限 · 审批 UX](../../docs/design/10-security-permissions-ux.md) |
| 决策   | Q6（Windows 沙箱）· Q11（并发与预算）· Q12（审计留痕）· Q26（macOS 首发）   |

## 这一层的东西有一个共同点

**错了不会报错，只会静默失效。** 路径判定漏一条、hook 输出写错一个字段、
审批理由留空 —— 三者的表现都是"策略像是生效了，其实没有"。
所以这个包里几乎每个导出都配了断言，且断言写的是**后果**而不是实现。

## 四条不能松的

1. **硬拦截对「完全访问」也生效**（10 §2.3）。用户点完全访问是为了装依赖、
   改工作空间外的项目文件，不是为了让 agent 读走 SSH 私钥。
   判定里**不看 `permission_mode`** —— 看了就等于给了绕过的口子。
2. **`..` 必须在匹配前解析掉**。`~/work/../.ssh/id_rsa` 不解析就会被判成工作空间内。
   这是 `paths.ts` 里最容易写错、后果最重的一处。
3. **未知的权限档位不隐藏**（10 §2.2）。企业加了我们不认识的 profile 时，
   用户应该看到它并能选，而不是"这个档位在 EvoWork 里消失了"。
4. **审计不记正文**（10 §6 / Q14 同口径）。`AuditRecord` 里**没有能装正文的字段**，
   路径只能以 `pathKind` + `pathDigest` 进去。想记正文得先改类型，而改类型会被 review 看见。

## 目录

```
src/
  paths.ts       三级路径策略：硬拦截 / 需审批 / 工作空间内
  profiles.ts    权限 profile 的中文文案 + 平台限制（Q26）
  execpolicy.ts  命令风险的四个维度 + 「为什么需要确认」
  limits.ts      并发公式（Q11）与预算闸门
  guardian.ts    内核四级风险 → EvoWork 行为 + 提示注入的用户可见提示
  audit.ts       审计记录形状 + 每日链式哈希
  platform.ts    本机安全能力页 + **Windows 隔离结论的开关**
  hooks/
    contract.ts  内核 hooks 的 I/O 契约（含三条实测到的硬约束）
    handlers.ts  四个 hook 的决策（纯函数，可测）
```

`plugins/hooks/evowork-policy/` 是随产品分发的策略包，它的 `bin/*.mjs` **只做 I/O**，
决策全在 `hooks/handlers.ts` 里 —— 放进脚本就没法测了。

## `execpolicy.ts` 不是安全边界

它用正则做启发式判定，用途是**给用户一句解释**。解析 shell 听起来更严谨，
但 `sh -c` 里可以有任意嵌套与拼接，一个"看起来解析对了"的实现会给出虚假的安全感。
真正的边界是沙箱（seatbelt / landlock）与 `paths.ts` 的路径判定。

## Windows 的结论**还没拿到**

Q6 决定暂用上游 `windows-sandbox-rs` 不自研，隔离强度在 M4 单独评估 ——
那次评估需要一台 Windows 机器，本轮拿不到。

`platform.ts` 把两种结论的行为都实现好了，由 `WINDOWS_ISOLATION` 选择。
**当前值是 `'unknown'`，行为与"不足"一致（保守侧）**，能力页上如实说"还没评估"。
默认按"足够"走的话，评估一旦得出"不足"，中间这段时间里 Windows 用户是在一个
我们以为安全、实际未知的环境里跑完全访问。

拿到结论后：改 `WINDOWS_ISOLATION` 一个常量，同时更新 `docs/status.md` 第 3 节。

## 还没做的

- **hook 包的 vendor 构建**（把 `@evowork/policy` 的产物放进 `plugins/hooks/evowork-policy/vendor/`）——
  属 M9 打包。开发时运行器会退回仓库里的 `dist/`。
- 策略包的**签名与下发**（R11 / 10 §8）：云端签名策略包 → 校验 → 写 `requirements.toml`。
- 审计的 UI（设置 →「用量与审计」，可筛选可导出）—— 属 M8 之后。
