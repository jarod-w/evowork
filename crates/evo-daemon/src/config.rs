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
        }
    }
}
