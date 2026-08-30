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
use std::path::Path;
use std::sync::Arc;

/// 一次工具返回该带什么污点。**基线是 `Tainted`，`Clean` 才是要论证的
/// 那一边**——这个函数是 02 §2 步骤 ③ 那道闸门在执行面的唯一电源，
/// 在它存在之前，`LocalExecutor` 三个出口全部写死 `Clean`，于是
/// `TaintLevel::Tainted` 在整个生产代码里没有任何构造点，闸门恒为假。
///
/// 判定按**来源**，不按"这次返回看起来危不危险"：内容级的启发式判断
/// （"含不含 http://"、"像不像指令"）恰恰是 04 开篇点名的那种嘱托性
/// 防护，一段精心构造的内容就能绕开。所以规则只有一条表，键是工具：
///
/// | 工具 | 回传什么 | 污点 |
/// |---|---|---|
/// | `fs.write` | 什么都不回传（`output: None`） | `Clean` |
/// | `fs.read` | 工作区里某个文件的全部内容 | `Tainted` |
/// | `shell.exec` | 任意命令的 stdout / stderr | `Tainted` |
/// | 其它（未知工具） | 不知道 | `Tainted` |
///
/// `fs.write` 是唯一的 `Clean`，理由不是"写文件比读文件安全"（并不），
/// 而是**它根本没有内容回流**：它的 `EffectOutcome::output` 恒为 `None`，
/// `actual_targets` 由调用参数推导（参数本身的污点早在上游就已经进了
/// `RunState.taint`，且污点只升不降，见 `TaintLevel::join`）。把它标成
/// `Tainted` 不会多防住任何东西，只会让"第一次写文件之后整条 run 永远
/// 需要审批"——那是噪声，不是安全。
///
/// 反过来，`fs.read` 与 `shell.exec` 回传的都是**工作区里的字节**：可能是
/// 人丢进来的外部对账单、可能是上一条命令从网上拉下来的、也可能是攻击者
/// 写进去的。谁写的这一层看不出来，所以一律不可信。
///
/// 未知工具走 `Tainted`，与 `config/tools.toml` 里"未列出的工具按最严
/// 处理"、以及 02 §4 那句「忘记写 manifest 的后果是『多问一次人』，不是
/// 『静默漏掉治理』」是同一条口径：漏标一个来源的代价必须是多问一次人。
///
/// **成功与失败用同一张表**（见 [`error_outcome`]）：失败路径绝不能比成功
/// 路径更干净，否则"想办法让这次调用失败"就成了一条洗白通道——
/// `EffectOutcome::error` 里本来就带着执行面的字符串，今天 daemon 没把它
/// 写进 Run Log，不代表明天不会。
fn outcome_taint(tool: &str) -> TaintLevel {
    match tool {
        "fs.write" => TaintLevel::Clean,
        _ => TaintLevel::Tainted,
    }
}

/// 三条工具路径遇到 `ExecError` 时的失败结局是一样的：状态 Error，
/// 没有 output，没有 actual_targets / actual_egress（没跑成，谈不上
/// "实际碰到了什么"）。抽出来避免三处分支各写一遍同样的六个字段。
///
/// `taint` 走的是与成功路径**同一个** [`outcome_taint`]，理由见那里。
fn error_outcome(tool: &str, e: ExecError) -> EffectOutcome {
    EffectOutcome {
        status: ToolResultStatus::Error,
        output: None,
        output_mime: "text/plain".to_owned(),
        taint: outcome_taint(tool),
        actual_targets: Vec::new(),
        actual_egress: Vec::new(),
        error: Some(e.to_string()),
    }
}

/// 把一个已解析的绝对路径转回「工作区内的相对路径」这一个命名空间。
///
/// `ResourceRef` 标识的是某个作用域（这里是工作区）内的资源，不是某台
/// 机器上的文件系统路径。工作区由 lease/run 标识，路径相对于工作区才有
/// 跨机器、跨时间的稳定含义；而 `resolve_in_workspace` 返回的绝对路径
/// 是符号链接防护的产物（见 workspace.rs），只在这台机器、这次运行里
/// 有意义。直接把它塞进 actual_targets 会有两个后果：
///   1) 与 `declared_targets`（`TargetSpec::resolve` 从参数原值取出的
///      工作区相对路径）永远落在不同命名空间，任何比对都会 100% 不匹配，
///      而这两个字段存在的全部意义就是互相比对（供应链行为异常检测）；
///   2) 绝对路径里带临时目录/机器路径，同一个 run 换台机器或换个目录
///      跑，Log 的 payload 就不同——Log 不再可移植，「同样输入产出
///      同样 Log」这条确定性前提也不成立。
///
/// 所以这里把它转回工作区相对路径，与 declared_targets 落在同一
/// 命名空间。用工作区根 strip 前缀，不重新做路径计算，也不碰
/// `resolve_in_workspace` 的返回类型或符号链接防护逻辑。
fn workspace_relative_target(lease: &Lease, target: &Path) -> Result<ResourceRef, ExecError> {
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
    Ok(ResourceRef {
        kind: "file".to_owned(),
        id: rel.to_string_lossy().into_owned(),
    })
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
        Ok(vec![workspace_relative_target(lease, &target)?])
    }

    /// `fs.read`：`config/tools.toml` 从 M1 起就声明了这个方法
    /// （`class = "read"`，targets 从 `/path` 取），但执行面一直没有实现
    /// ——任何真实调用都会掉进 `execute()` 的 `other =>` 分支变成
    /// `UnknownTool`。治理面声明了、执行面跑不通，这个不一致本身要补；
    /// 更要紧的是，它是污点闸门最典型、也最该能当场演的那个入口：工作区
    /// 里的文件可能是人丢进来的外部对账单、可能是上一条 `shell.exec` 从
    /// 网上拉下来的，读回来的内容一律不可信（见 [`outcome_taint`]）。
    ///
    /// 路径解析走与 `fs.write` **同一个** `resolve_in_workspace`——读也要
    /// 受工作区边界、符号链接与敏感路径前缀的约束，不能因为"只是读"就走
    /// 一条更松的路径校验。
    async fn run_fs_read(
        &self,
        lease: &Lease,
        effect: &DispatchedEffect,
    ) -> Result<EffectOutcome, ExecError> {
        let path = effect
            .params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ExecError::BadParams("missing /path".into()))?;
        let target = resolve_in_workspace(&lease.workspace, path)?;
        // 原样读字节，不做 UTF-8 解码：文件可能根本不是文本，而"是不是
        // 合法 UTF-8"不该决定一次读能不能成功。内容进 blob，事件 payload
        // 里只留 content_hash（01 §3）。
        let bytes = std::fs::read(&target)?;
        Ok(EffectOutcome {
            status: ToolResultStatus::Ok,
            output: Some(bytes),
            output_mime: "application/octet-stream".to_owned(),
            taint: outcome_taint("fs.read"),
            actual_targets: vec![workspace_relative_target(lease, &target)?],
            actual_egress: Vec::new(),
            error: None,
        })
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
            taint: outcome_taint("shell.exec"),
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
        let tool = effect.request.tool.as_str();
        match tool {
            "fs.write" => match self.run_fs_write(&lease, &effect).await {
                // `output: None` 是 `fs.write` 这一支的**结构性事实**，不是
                // 一次偶然的取值——`outcome_taint("fs.write") == Clean` 整个
                // 建立在它之上（那里的表逐条讲了为什么）。这一支要是哪天开始
                // 回传内容，`outcome_taint` 必须跟着改。
                Ok(actual_targets) => EffectOutcome {
                    status: ToolResultStatus::Ok,
                    output: None,
                    output_mime: "application/octet-stream".to_owned(),
                    taint: outcome_taint(tool),
                    actual_targets,
                    actual_egress: Vec::new(),
                    error: None,
                },
                Err(e) => error_outcome(tool, e),
            },
            "fs.read" => match self.run_fs_read(&lease, &effect).await {
                Ok(outcome) => outcome,
                Err(e) => error_outcome(tool, e),
            },
            "shell.exec" => match self.run_shell_exec(&lease, &effect).await {
                Ok(outcome) => outcome,
                Err(e) => error_outcome(tool, e),
            },
            other => error_outcome(other, ExecError::UnknownTool(other.to_owned())),
        }
    }

    async fn heartbeat(&self, _lease: &Lease) -> Result<(), ExecError> {
        Ok(())
    }
}
