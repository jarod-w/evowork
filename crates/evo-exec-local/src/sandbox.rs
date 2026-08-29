use async_trait::async_trait;
use evo_exec::{CommandSpec, EgressPolicy, ExecError, Sandbox, SandboxOutput, WorkspaceHandle};
use tokio::process::Command;

/// Linux 开发机上的沙箱实现：工作区级隔离 + 强制走 proxy。
///
/// **不做内核级隔离**——那是 macOS seatbelt 实现的事（08 §3）。
/// 但行为语义与 seatbelt 版一致（同一张隔离矩阵，05 §3），
/// 因此沙箱行为的测试可以复用：换实现时换的是隔离手段，不是断言。
pub struct WorkspaceOnlySandbox;

impl WorkspaceOnlySandbox {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WorkspaceOnlySandbox {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Sandbox for WorkspaceOnlySandbox {
    async fn spawn(
        &self,
        spec: &CommandSpec,
        ws: &WorkspaceHandle,
        egress: &EgressPolicy,
    ) -> Result<SandboxOutput, ExecError> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        cmd.current_dir(ws.path());
        // 子进程继承同一 profile 与 proxy 设置（05 §3）
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if let Some(addr) = &egress.proxy_addr {
            cmd.env("HTTP_PROXY", addr);
            cmd.env("HTTPS_PROXY", addr);
            cmd.env("http_proxy", addr);
            cmd.env("https_proxy", addr);
            // 没有它，很多客户端会绕过 proxy 直连
            cmd.env("NO_PROXY", "");
        }
        let out = cmd.output().await?;
        Ok(SandboxOutput {
            exit_code: out.status.code().unwrap_or(-1),
            stdout: out.stdout,
            stderr: out.stderr,
        })
    }

    fn kind(&self) -> &'static str {
        "workspace-only"
    }
}
