use crate::workspace::resolve_in_workspace;
use async_trait::async_trait;
use evo_exec::{
    CommandSpec, DispatchedEffect, EffectOutcome, ExecError, Executor, ExecutorCapabilities, Lease,
    Sandbox,
};
use evo_protocol::effect::{EffectClass, EgressRef, ResourceRef};
use evo_protocol::events::effect::ToolResultStatus;
use evo_protocol::ids::ExecutorId;
use evo_protocol::taint::TaintLevel;
use std::collections::BTreeMap;
use std::sync::Arc;

/// 两条工具路径（`fs.write`、`shell.exec`）遇到 `ExecError` 时的失败
/// 结局是一样的：状态 Error，没有 output，没有 actual_targets /
/// actual_egress（没跑成，谈不上"实际碰到了什么"）。抽出来避免两处
/// 分支各写一遍同样的六个字段。
fn error_outcome(e: ExecError) -> EffectOutcome {
    EffectOutcome {
        status: ToolResultStatus::Error,
        output: None,
        output_mime: "text/plain".to_owned(),
        taint: TaintLevel::Clean,
        actual_targets: Vec::new(),
        actual_egress: Vec::new(),
        error: Some(e.to_string()),
    }
}

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

    /// `Sandbox::spawn` 的第一个真实调用者（M2 Task 5）——之前它写好了
    /// 但零调用者。参数形状直接照抄 `CommandSpec`：`/program` 必填，
    /// `/args` 可选（缺省为空）。刻意不支持传入自定义 `env` 或覆盖
    /// `cwd`——env 由沙箱自己决定注入什么（`env_clear` + PATH 白名单 +
    /// proxy，见 `sandbox.rs`），cwd 恒等于工作区（`Sandbox::spawn` 的
    /// 签名只接受一个 `WorkspaceHandle`，没有子目录的概念）。这样模型
    /// 传进来的参数里根本没有能改写这两样东西的字段，谈不上"绕过"。
    async fn run_shell_exec(
        &self,
        lease: &Lease,
        effect: &DispatchedEffect,
    ) -> Result<EffectOutcome, ExecError> {
        let program = effect
            .params
            .get("program")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ExecError::BadParams("missing /program".into()))?;
        let args: Vec<String> = effect
            .params
            .get("args")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let spec = CommandSpec {
            program: program.to_owned(),
            args,
            env: BTreeMap::new(),
        };
        let out = self
            .sandbox
            .spawn(&spec, &lease.workspace, &lease.egress_policy)
            .await?;

        // 命令本身跑起来了（spawn 成功）——它自己的退出码是数据，不是
        // 执行器层面的失败，所以无论 exit_code 是不是 0，ToolResultStatus
        // 都是 Ok。真正的 ExecError（程序不在白名单、spawn 失败……）
        // 会在上面 `?` 处提前返回，走 execute() 里统一的错误分支。
        let payload = serde_json::json!({
            "exit_code": out.exit_code,
            "stdout": String::from_utf8_lossy(&out.stdout),
            "stderr": String::from_utf8_lossy(&out.stderr),
        });

        // --- actual_targets / actual_egress：如实回报，不夸大 ---
        //
        // `shell.exec` 的参数是任意命令行，manifest 里的 targets 静态
        // 提取不出来，只能声明成字面量"整个工作区"（config/tools.toml）。
        // executor 这一层唯一能如实确认的，正是"这条命令确实是在这个
        // 工作区里跑的"（cwd 就是 lease.workspace）——不多不少，所以
        // actual_targets 直接复用 Gateway 已经解析好、挂在
        // `effect.request.targets` 上的声明值，而不是编出一个更精细但
        // 并不真实的观测。等以后有更细粒度的观测手段（比如给 sandbox
        // 加执行前后的文件系统 diff），再让 actual 比 declared 更丰富——
        // 到那时这里的比对代码不用改，变的只是 actual 这一侧的数据来源。
        let actual_targets = effect.request.targets.clone();

        // egress 同理：唯一能如实回报的是"这次调用是不是真的配出了一个
        // proxy 地址"。manifest 声明 `shell.exec` 总是
        // `egress = [{ via = "proxy" }]`，但如果这次 lease 的
        // egress_policy 里根本没有 proxy_addr（比如测试用的
        // `EgressPolicy::deny_all()`，或者未来某个不需要出网的
        // profile），"实际上并没有出口路径"就是一条真实、值得记录的
        // 偏离——即使 POC 期只记录不拦截。
        let actual_egress: Vec<EgressRef> = if lease.egress_policy.proxy_addr.is_some() {
            effect.request.egress.clone()
        } else {
            Vec::new()
        };

        Ok(EffectOutcome {
            status: ToolResultStatus::Ok,
            output: Some(serde_json::to_vec(&payload).expect("json object serializes to bytes")),
            output_mime: "application/json".to_owned(),
            taint: TaintLevel::Clean,
            actual_targets,
            actual_egress,
            error: None,
        })
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
        match effect.request.tool.as_str() {
            "fs.write" => match self.run_fs_write(&lease, &effect).await {
                Ok(actual_targets) => EffectOutcome {
                    status: ToolResultStatus::Ok,
                    output: None,
                    output_mime: "application/octet-stream".to_owned(),
                    taint: TaintLevel::Clean,
                    actual_targets,
                    actual_egress: Vec::new(),
                    error: None,
                },
                Err(e) => error_outcome(e),
            },
            "shell.exec" => match self.run_shell_exec(&lease, &effect).await {
                Ok(outcome) => outcome,
                Err(e) => error_outcome(e),
            },
            other => error_outcome(ExecError::UnknownTool(other.to_owned())),
        }
    }

    async fn heartbeat(&self, _lease: &Lease) -> Result<(), ExecError> {
        Ok(())
    }
}
