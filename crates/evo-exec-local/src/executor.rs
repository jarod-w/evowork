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
        // `ResourceRef` 标识的是某个作用域（这里是工作区）内的资源，不是某台
        // 机器上的文件系统路径。工作区由 lease/run 标识，路径相对于工作区才有
        // 跨机器、跨时间的稳定含义；而 `resolve_in_workspace` 返回的绝对路径
        // 是符号链接防护的产物（见 workspace.rs），只在这台机器、这次运行里
        // 有意义。直接把它塞进 actual_targets 会有两个后果：
        //   1) 与 `declared_targets`（TargetSpec::resolve 从参数原值取出的
        //      工作区相对路径）永远落在不同命名空间，任何比对都会 100% 不匹配，
        //      而这两个字段存在的全部意义就是互相比对（供应链行为异常检测）；
        //   2) 绝对路径里带临时目录/机器路径，同一个 run 换台机器或换个目录
        //      跑，Log 的 payload 就不同——Log 不再可移植，「同样输入产出
        //      同样 Log」这条确定性前提也不成立。
        // 所以这里把它转回工作区相对路径，与 declared_targets 落在同一
        // 命名空间。用工作区根 strip 前缀，不重新做路径计算，也不碰
        // resolve_in_workspace 的返回类型或符号链接防护逻辑。
        let rel = target.strip_prefix(lease.workspace.path()).map_err(|_| {
            // 路径校验（resolve_in_workspace）已经保证 target 落在工作区之内，
            // strip 失败意味着那条保证被破坏了——这是一个不变量违反，不是
            // 可以静默回退成绝对路径的普通情况，必须报错而不是吞掉。
            ExecError::BadParams(format!(
                "resolved target {} escaped the workspace {} it was validated against",
                target.display(),
                lease.workspace.path().display()
            ))
        })?;
        Ok(vec![ResourceRef {
            kind: "file".to_owned(),
            id: rel.to_string_lossy().into_owned(),
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
