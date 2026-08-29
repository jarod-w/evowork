use crate::{PolicyContext, PolicyDecision, PolicyError, PolicyHook, RiskLevel};
use evo_protocol::effect::EffectClass;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct PolicyFile {
    version: String,
    #[serde(default)]
    rule: Vec<Rule>,
}

#[derive(Debug, Deserialize)]
struct Rule {
    id: String,
    #[serde(default)]
    class: Option<EffectClass>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    reversible: Option<bool>,
    decision: String,
    #[serde(default)]
    risk: Option<RiskLevel>,
    #[serde(default)]
    reason_code: Option<String>,
}

impl Rule {
    fn matches(&self, ctx: &PolicyContext) -> bool {
        if let Some(c) = self.class
            && c != ctx.class
        {
            return false;
        }
        if let Some(t) = &self.tool
            && t != ctx.tool.as_str()
        {
            return false;
        }
        if let Some(r) = self.reversible
            && r != ctx.reversible
        {
            return false;
        }
        true
    }

    fn decision(&self) -> Result<PolicyDecision, PolicyError> {
        match self.decision.as_str() {
            "allow" => Ok(PolicyDecision::Allow),
            "deny" => Ok(PolicyDecision::Deny {
                reason_code: self.reason_code.clone().unwrap_or_else(|| self.id.clone()),
            }),
            "require_approval" => Ok(PolicyDecision::RequireApproval {
                risk: self.risk.unwrap_or(RiskLevel::L2),
            }),
            other => Err(PolicyError::UnknownDecision(
                self.id.clone(),
                other.to_owned(),
            )),
        }
    }
}

/// POC 期的策略实现：读一份 TOML，规则从上到下先命中先赢。
///
/// **分级规则放在这里，不硬编码在 Gateway**——换客户只换 TOML（02 §6）。
pub struct HardcodedPolicy {
    file: PolicyFile,
}

impl HardcodedPolicy {
    pub fn from_toml_str(s: &str) -> Result<Self, PolicyError> {
        let file: PolicyFile = toml::from_str(s)?;
        // 加载期就把每条规则的 decision 校验一遍：typo（如 require_aproval）在这里
        // 直接让加载失败并带上规则 id + 非法字符串，而不是留到该规则被匹配命中的
        // 那一刻才静默降级为 Deny（见 evaluate_with_trace 里的 unwrap_or 注释）。
        for rule in &file.rule {
            rule.decision()?;
        }
        Ok(Self { file })
    }

    pub fn from_path(p: &Path) -> Result<Self, PolicyError> {
        Self::from_toml_str(&std::fs::read_to_string(p)?)
    }
}

impl PolicyHook for HardcodedPolicy {
    fn evaluate(&self, ctx: &PolicyContext) -> PolicyDecision {
        self.evaluate_with_trace(ctx).0
    }

    /// 规则从上到下先命中先赢，命中的规则 id 回填进 policy.evaluated.rules_hit。
    fn evaluate_with_trace(&self, ctx: &PolicyContext) -> (PolicyDecision, Vec<String>) {
        for rule in &self.file.rule {
            if rule.matches(ctx) {
                // `from_toml_str` 已经在加载期对每条规则预先调用过 decision()，
                // 非法的 decision 字符串（typo 等）在那时就会让加载失败。走到这里
                // 理论上不可达，unwrap_or 只是留作防御——万一有人绕过
                // `from_toml_str` 直接构造 HardcodedPolicy（比如手拼 PolicyFile）。
                let decision = rule.decision().unwrap_or(PolicyDecision::Deny {
                    reason_code: "malformed_rule".to_owned(),
                });
                return (decision, vec![rule.id.clone()]);
            }
        }
        // 没有规则命中 = 放行。注意这不只是「工具没有 manifest」的情况——
        // 一个有 manifest、effect class 明确、只是恰好没被任何规则覆盖到的
        // class/tool 组合，同样会在这里默默放行。Gateway 那条 manifest 缺失
        // 的兜底（02 §4）管的是另一件事，不会兜住这条路径。将来新增工具或新的
        // effect class 时，必须靠测试或 checklist 保证配了对应的策略规则——
        // 不能指望这一层或 Gateway 会自动兜底。
        (PolicyDecision::Allow, Vec::new())
    }

    fn version(&self) -> &str {
        &self.file.version
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PolicyContext, PolicyDecision, PolicyHook, RiskLevel};
    use evo_protocol::{EffectClass, TaintLevel, ToolId};

    const POLICY: &str = r#"
version = "poc-1"

[[rule]]
id = "read-is-free"
class = "read"
decision = "allow"

[[rule]]
id = "external-needs-approval"
class = "external"
decision = "require_approval"
risk = "l3"

[[rule]]
id = "irreversible-write-needs-approval"
class = "write"
reversible = false
decision = "require_approval"
risk = "l2"
"#;

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
    fn reads_are_allowed() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(
            p.evaluate(&ctx("fs.read", EffectClass::Read, true)),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn external_effects_require_l3_approval() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(
            p.evaluate(&ctx("wecom.send", EffectClass::External, false)),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L3
            }
        );
    }

    #[test]
    fn reversible_writes_fall_through_to_allow() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(
            p.evaluate(&ctx("fs.write", EffectClass::Write, true)),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn irreversible_writes_require_l2_approval() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(
            p.evaluate(&ctx("shell.exec", EffectClass::Write, false)),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L2
            }
        );
    }

    #[test]
    fn version_goes_into_the_policy_evaluated_event() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(p.version(), "poc-1");
    }

    #[test]
    fn typo_in_decision_fails_to_load_instead_of_silently_denying_on_match() {
        let bad_policy = r#"
version = "poc-1"

[[rule]]
id = "external-needs-approval"
class = "external"
decision = "require_aproval"
"#;
        let Err(err) = HardcodedPolicy::from_toml_str(bad_policy) else {
            panic!("expected loading a policy with a typo'd decision to fail");
        };
        match err {
            PolicyError::UnknownDecision(id, decision) => {
                assert_eq!(id, "external-needs-approval");
                assert_eq!(decision, "require_aproval");
            }
            other => panic!("expected UnknownDecision, got {other:?}"),
        }
    }

    #[test]
    fn first_matching_rule_wins_and_is_reported() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        let (decision, rules) =
            PolicyHook::evaluate_with_trace(&p, &ctx("fs.read", EffectClass::Read, true));
        assert_eq!(decision, PolicyDecision::Allow);
        assert_eq!(rules, vec!["read-is-free".to_owned()]);
    }
}
