//! 集成测试：真正从磁盘加载仓库根的 `config/policy.toml`，
//! 而不是靠测试里手写的 TOML 字符串常量与它人工保持一致。
//! 改坏了其中一份、忘了同步另一份，这里会当场失败。

use evo_policy::{HardcodedPolicy, PolicyContext, PolicyDecision, PolicyHook, RiskLevel};
use evo_protocol::{EffectClass, TaintLevel, ToolId};
use std::path::PathBuf;

fn repo_config_policy_path() -> PathBuf {
    // crates/evo-policy/tests -> crates/evo-policy -> crates -> 仓库根
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("crates/evo-policy 应该有两级父目录，即 crates/ 和仓库根")
        .join("config/policy.toml")
}

fn ctx(tool: &str, class: EffectClass, reversible: bool) -> PolicyContext {
    PolicyContext {
        tool: ToolId::from(tool),
        class,
        taint: TaintLevel::Clean,
        targets: Vec::new(),
        reversible,
    }
}

#[test]
fn repo_policy_toml_loads_and_reports_expected_version() {
    let path = repo_config_policy_path();
    let policy = HardcodedPolicy::from_path(&path)
        .unwrap_or_else(|e| panic!("加载 {} 失败: {e}", path.display()));
    assert_eq!(policy.version(), "poc-1");
}

#[test]
fn repo_policy_toml_allows_reads() {
    let policy = HardcodedPolicy::from_path(&repo_config_policy_path()).unwrap();
    assert_eq!(
        policy.evaluate(&ctx("fs.read", EffectClass::Read, true)),
        PolicyDecision::Allow
    );
}

#[test]
fn repo_policy_toml_requires_l3_approval_for_external_effects() {
    let policy = HardcodedPolicy::from_path(&repo_config_policy_path()).unwrap();
    assert_eq!(
        policy.evaluate(&ctx("wecom.send", EffectClass::External, false)),
        PolicyDecision::RequireApproval {
            risk: RiskLevel::L3
        }
    );
}

#[test]
fn repo_policy_toml_requires_l2_approval_for_irreversible_writes() {
    let policy = HardcodedPolicy::from_path(&repo_config_policy_path()).unwrap();
    assert_eq!(
        policy.evaluate(&ctx("shell.exec", EffectClass::Write, false)),
        PolicyDecision::RequireApproval {
            risk: RiskLevel::L2
        }
    );
}

#[test]
fn repo_policy_toml_falls_through_to_allow_for_reversible_writes() {
    let policy = HardcodedPolicy::from_path(&repo_config_policy_path()).unwrap();
    assert_eq!(
        policy.evaluate(&ctx("fs.write", EffectClass::Write, true)),
        PolicyDecision::Allow
    );
}
