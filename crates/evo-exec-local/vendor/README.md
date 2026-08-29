# 受控 vendor

本目录存放 codex 上游代码的受控副本。**目录内不做任何修改**——
需要适配就在外面包一层。改了 vendor 目录就是借错了层（08 §3 规则 4）。

## 当前状态

M1 阶段 0/1 期间本目录为空：开发机是 Linux，macOS seatbelt 子集
（`codex-seatbelt/`）无法编译与实测，按已定的「接口先行」方案推迟到
拿到 macOS 真机后再同步。

`Sandbox` trait 与 `WorkspaceOnlySandbox` 已就位，seatbelt 实现是同一个
trait 的第二个实现，接入时不动调用点。

## 同步

同步由 `scripts/sync-codex-vendor.sh` 一条命令完成，不是手工拷贝。
每个子目录带一个 `UPSTREAM` 文件，记录来源 repo、rev、路径、同步日期与
Apache-2.0 声明。CI 检查 6 校验本目录与上游 pin 住的 rev 逐字节一致。

上游 rev（POC 期冻结）：`c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3`
