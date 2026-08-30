use evo_protocol::budget::BudgetSpec;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct DaemonConfig {
    pub db_path: PathBuf,
    pub blob_root: PathBuf,
    pub workspace_root: PathBuf,
    pub principal: String,
    pub policy_toml: String,
    pub tools_toml: String,
    pub pricing_toml: String,
    pub context_profile: String,
    /// 出口 allowlist。**是配置不是常量**：开发期与交付形态用同一份代码、
    /// 不同一份 allowlist（05 §4）。
    pub egress_allow: Vec<String>,
    pub proxy_addr: Option<String>,
    /// 这个 daemon 起的每一条新 run 的初始预算——原样写进
    /// `run.created.budget`，`reduce` 把它折叠成 `RunState::budget`，内核的
    /// 预算闸门（`evo_kernel::decide`）与 Gateway 的第⑤步读的都是它。
    ///
    /// **在这个字段存在之前，`Runtime::start` 无条件写 `BudgetSpec::default()`
    /// （五个字段全 `None`）**，于是闸门的三个 `is_some_and` 全部短路成
    /// false：预算判定这条路径存在、编译得过、也有单元测试，唯独在真实的
    /// daemon 里一次都不可能为真。这个字段是那条链路缺的第一根线
    /// （M2 终审 BL-10）。
    ///
    /// 全 `None` 仍然是**不设限**，不是「设成 0」——这是 `BudgetSpec` 上
    /// 一贯的语义，见 `evo_kernel::decide` 里 `budget_exhausted` 的注释。
    /// 所以 `for_test` 保持默认值：接通闸门不该让既有的、没配预算的测试
    /// 与用例突然撞上限。
    ///
    /// 提额不走这里。改一条**已经在跑**的 run 的额度，唯一的办法是往它的
    /// Log 追加一条 `budget.amended`（见 [`crate::Runtime::amend_budget`]）；
    /// 配置只决定新 run 的起点，改配置对既有 run 无效——它们的额度活在
    /// 各自的 Log 里。
    pub budget: BudgetSpec,
}

impl DaemonConfig {
    /// 测试用：全部落在一个临时目录下，策略/工具/定价读仓库里的 config/。
    pub fn for_test(dir: &Path) -> Self {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        Self {
            db_path: dir.join("runlog.sqlite"),
            blob_root: dir.join("blobs"),
            workspace_root: dir.join("workspaces"),
            principal: "u-test".to_owned(),
            policy_toml: std::fs::read_to_string(repo.join("config/policy.toml")).unwrap(),
            tools_toml: std::fs::read_to_string(repo.join("config/tools.toml")).unwrap(),
            pricing_toml: std::fs::read_to_string(repo.join("config/pricing.toml")).unwrap(),
            context_profile: "default".to_owned(),
            egress_allow: Vec::new(),
            proxy_addr: None,
            budget: BudgetSpec::default(),
        }
    }
}
