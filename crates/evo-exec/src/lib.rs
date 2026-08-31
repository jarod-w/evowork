//! 执行面接口。Executor 无状态，凭 lease 从 Gateway 领取 effect 执行。
//!
//! POC 期只有一种实现且与 daemon 同进程，**但 lease 机制现在就存在**——
//! 它现在是结构体传参，将来是一次 RPC 领取，调用点不变。

use async_trait::async_trait;
use evo_protocol::effect::{EffectClass, EffectRequest, EgressRef, ResourceRef};
use evo_protocol::events::effect::{ExecutionMode, ToolResultStatus};
use evo_protocol::ids::{EffectId, ExecutorId, LeaseId, RunId};
use evo_protocol::taint::TaintLevel;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

// 本 crate 的公开 API 里出现的 protocol 类型一并 re-export，
// 免得每个消费者都要同时依赖 evo-protocol 才能构造一个 Lease。
pub use evo_protocol::effect::CapabilityToken;

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("lease expired: {0}")]
    LeaseExpired(String),
    #[error("path escapes the workspace: {0}")]
    PathEscape(String),
    #[error("blocked sensitive path: {0}")]
    SensitivePath(String),
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    #[error("bad params: {0}")]
    BadParams(String),
    /// PATH 安全决策（M2 Task 5，见 `evo_exec_local::sandbox` 的文档注释）：
    /// 子进程解析裸程序名走一份固定白名单，不透传调用方的 PATH。命中
    /// 这个错误说明调用方（模型）想跑的程序名不在白名单里——这是预期的
    /// 拒绝，不是 bug。
    #[error("program not allowed by the sandbox's PATH policy: {0}")]
    ProgramNotAllowed(String),
}

/// 工作区句柄。**从第一天就是抽象，不是 PathBuf 别名**——
/// Fleet 期它会变成「某个 COW 快照的挂载点」。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceHandle {
    id: String,
    path: PathBuf,
}

impl WorkspaceHandle {
    pub fn new(id: &str, path: PathBuf) -> Self {
        Self {
            id: id.to_owned(),
            path,
        }
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// 出口策略。allowlist 是配置，不是代码常量——
/// 开发期与交付形态用同一份代码、不同一份 allowlist（05 §4）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EgressPolicy {
    pub allow: Vec<String>,
    pub proxy_addr: Option<String>,
}

impl EgressPolicy {
    pub fn deny_all() -> Self {
        Self::default()
    }

    /// **精确匹配，不做后缀匹配。** 后缀匹配会让 `evil.deepseek.com.attacker.net`
    /// 通过 allowlist——演示时刻 1 打开出口日志时那就是事故。
    pub fn permits(&self, host: &str) -> bool {
        self.allow.iter().any(|h| h == host)
    }
}

#[derive(Clone, Debug)]
pub struct Lease {
    pub lease_id: LeaseId,
    pub run_id: RunId,
    pub effect_id: EffectId,
    /// 发租时的 sampled clock（与 `expires_at_ms` 同源）。执行面用
    /// `expires_at_ms.saturating_sub(issued_at_ms)` 得到剩余窗口，
    /// **不读墙钟**。
    pub issued_at_ms: u64,
    /// 绝对截止时刻，来自 env.sampled，不是执行器自己读时钟。
    pub expires_at_ms: u64,
    pub workspace: WorkspaceHandle,
    pub egress_policy: EgressPolicy,
    pub capability: CapabilityToken,
}

#[derive(Clone, Debug)]
pub struct DispatchedEffect {
    pub request: EffectRequest,
    /// 参数正文。Gateway 从 blob 取出后传进来——执行面不直接碰 blob store。
    pub params: serde_json::Value,
    pub mode: ExecutionMode,
}

#[derive(Clone, Debug)]
pub struct EffectOutcome {
    pub status: ToolResultStatus,
    pub output: Option<Vec<u8>>,
    pub output_mime: String,
    pub taint: TaintLevel,
    /// 与 declared_targets 比对：声明只读却在写文件，就是供应链行为异常。
    /// POC 期只记录不拦截，但字段与比对代码现在就写。
    pub actual_targets: Vec<ResourceRef>,
    pub actual_egress: Vec<EgressRef>,
    pub error: Option<String>,
    /// 执行器回报的实际费用。本地工具恒为 `None`，daemon 再去查定价表。
    /// `Some(0)` 表示「跑了，但这回免费」，会压掉表上的那一行。
    pub cost_micros: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct ExecutorCapabilities {
    pub classes: Vec<EffectClass>,
    pub has_network: bool,
    pub platform: String,
}

#[async_trait]
pub trait Executor: Send + Sync {
    fn id(&self) -> ExecutorId;
    fn capabilities(&self) -> ExecutorCapabilities;
    async fn execute(&self, lease: Lease, effect: DispatchedEffect) -> EffectOutcome;
    async fn heartbeat(&self, lease: &Lease) -> Result<(), ExecError>;
}

#[derive(Clone, Debug, Default)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct SandboxOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// stdout 或 stderr 至少有一侧触到了字节上限，内容已被截断。
    pub truncated: bool,
}

/// 子进程最长运行时间的硬上限。与 daemon 写进租约的窗口（60s）对齐。
/// `Lease.expires_at_ms - issued_at_ms` 算出的剩余时间再与这个值取 min，
/// 防止测试里 `expires_at_ms: u64::MAX` 把 `timeout` 变成「永远等」。
pub const SANDBOX_TIMEOUT_CAP_MS: u64 = 60_000;

/// stdout / stderr **各自**的捕获上限。超过就停读、杀掉子进程，避免
/// 一份输出在 `from_utf8_lossy` + `json!` + blob 里复制三份撑爆 daemon。
pub const SANDBOX_MAX_OUTPUT_BYTES: usize = 1024 * 1024;

impl Lease {
    /// 子进程最多再跑多久。执行面不读墙钟：窗口完全由租约上两个
    /// sampled 时刻相减得到，再封顶 [`SANDBOX_TIMEOUT_CAP_MS`]。
    /// 剩余 0 表示租约已过期，调用方应直接返回 [`ExecError::LeaseExpired`]。
    pub fn spawn_timeout(&self) -> Duration {
        let remaining = self.expires_at_ms.saturating_sub(self.issued_at_ms);
        Duration::from_millis(remaining.min(SANDBOX_TIMEOUT_CAP_MS))
    }
}

/// 沙箱。**这是调用点，它现在就正确**——
/// macOS seatbelt 实现是同一个 trait 的第二个实现（08 §3）。
#[async_trait]
pub trait Sandbox: Send + Sync {
    async fn spawn(
        &self,
        spec: &CommandSpec,
        ws: &WorkspaceHandle,
        egress: &EgressPolicy,
        timeout: Duration,
        max_output_bytes: usize,
    ) -> Result<SandboxOutput, ExecError>;

    /// 进 executor capabilities 与交付说明——「这台机器上跑的是哪种沙箱」必须可查。
    fn kind(&self) -> &'static str;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn workspace_handle_is_an_abstraction_not_a_path_alias() {
        // Fleet 期 WorkspaceHandle 会变成「某个 COW 快照的挂载点」。
        // 现在就要有 id，否则将来换实现要改所有调用点。
        let ws = WorkspaceHandle::new("r-1", PathBuf::from("/tmp/ws"));
        assert_eq!(ws.id(), "r-1");
        assert_eq!(ws.path(), std::path::Path::new("/tmp/ws"));
    }

    #[test]
    fn a_lease_carries_its_deadline_from_sampled_time_not_a_clock_read() {
        // expires_at_ms 来自 env.sampled，执行器不许自己读时钟
        let lease = Lease {
            lease_id: LeaseId::from("l-1"),
            run_id: RunId::from("r-1"),
            effect_id: EffectId::from("e-1"),
            issued_at_ms: 1_756_461_600_000,
            expires_at_ms: 1_756_461_660_000,
            workspace: WorkspaceHandle::new("r-1", PathBuf::from("/tmp/ws")),
            egress_policy: EgressPolicy::deny_all(),
            capability: CapabilityToken {
                subject: "u-1".into(),
                scopes: vec!["*".into()],
            },
        };
        assert_eq!(lease.expires_at_ms, 1_756_461_660_000);
        assert_eq!(lease.spawn_timeout(), Duration::from_millis(60_000));
    }

    #[test]
    fn a_lease_past_its_deadline_has_a_zero_spawn_timeout() {
        let lease = Lease {
            lease_id: LeaseId::from("l-1"),
            run_id: RunId::from("r-1"),
            effect_id: EffectId::from("e-1"),
            issued_at_ms: 1_000,
            expires_at_ms: 999,
            workspace: WorkspaceHandle::new("r-1", PathBuf::from("/tmp/ws")),
            egress_policy: EgressPolicy::deny_all(),
            capability: CapabilityToken {
                subject: "u-1".into(),
                scopes: vec!["*".into()],
            },
        };
        assert_eq!(lease.spawn_timeout(), Duration::from_millis(0));
    }

    #[test]
    fn deny_all_egress_permits_nothing() {
        let p = EgressPolicy::deny_all();
        assert!(!p.permits("api.deepseek.com"));
    }

    #[test]
    fn allowlist_matches_exact_hosts_only() {
        let p = EgressPolicy {
            allow: vec!["api.deepseek.com".into()],
            proxy_addr: None,
        };
        assert!(p.permits("api.deepseek.com"));
        assert!(
            !p.permits("evil-api.deepseek.com.attacker.net"),
            "后缀匹配会让 allowlist 形同虚设"
        );
    }
}
