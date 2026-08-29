use crate::workspace::resolve_in_workspace;
use async_trait::async_trait;
use evo_exec::{
    DispatchedEffect, EffectOutcome, ExecError, Executor, ExecutorCapabilities, Lease, Sandbox,
};
use evo_protocol::effect::{EffectClass, ResourceRef};
use evo_protocol::events::effect::ToolResultStatus;
use evo_protocol::ids::ExecutorId;
use evo_protocol::taint::TaintLevel;
use std::sync::Arc;

pub struct LocalExecutor {
    sandbox: Arc<dyn Sandbox>,
}

impl LocalExecutor {
    pub fn new(sandbox: Arc<dyn Sandbox>) -> Self {
        Self { sandbox }
    }

    async fn run_fs_write(
        &self,
        lease: &Lease,
        effect: &DispatchedEffect,
    ) -> Result<Vec<ResourceRef>, ExecError> {
        let path = effect
            .params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ExecError::BadParams("missing /path".into()))?;
        let content = effect
            .params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ExecError::BadParams("missing /content".into()))?;
        let target = resolve_in_workspace(&lease.workspace, path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, content)?;
        Ok(vec![ResourceRef {
            kind: "file".to_owned(),
            id: target.to_string_lossy().into_owned(),
        }])
    }
}

#[async_trait]
impl Executor for LocalExecutor {
    fn id(&self) -> ExecutorId {
        ExecutorId::from("local")
    }

    fn capabilities(&self) -> ExecutorCapabilities {
        ExecutorCapabilities {
            classes: vec![EffectClass::Read, EffectClass::Write, EffectClass::Compute],
            has_network: false,
            platform: format!("{}:{}", std::env::consts::OS, self.sandbox.kind()),
        }
    }

    async fn execute(&self, lease: Lease, effect: DispatchedEffect) -> EffectOutcome {
        let result = match effect.request.tool.as_str() {
            "fs.write" => self.run_fs_write(&lease, &effect).await,
            other => Err(ExecError::UnknownTool(other.to_owned())),
        };
        match result {
            Ok(actual_targets) => EffectOutcome {
                status: ToolResultStatus::Ok,
                output: None,
                output_mime: "application/octet-stream".to_owned(),
                taint: TaintLevel::Clean,
                actual_targets,
                actual_egress: Vec::new(),
                error: None,
            },
            Err(e) => EffectOutcome {
                status: ToolResultStatus::Error,
                output: None,
                output_mime: "text/plain".to_owned(),
                taint: TaintLevel::Clean,
                actual_targets: Vec::new(),
                actual_egress: Vec::new(),
                error: Some(e.to_string()),
            },
        }
    }

    async fn heartbeat(&self, _lease: &Lease) -> Result<(), ExecError> {
        Ok(())
    }
}
