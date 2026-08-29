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
        Ok(Self {
            file: toml::from_str(s)?,
        })
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
                let decision = rule.decision().unwrap_or(PolicyDecision::Deny {
                    reason_code: "malformed_rule".to_owned(),
                });
                return (decision, vec![rule.id.clone()]);
            }
        }
        // 没有规则命中 = 放行。真正的兜底最严在 Gateway 的 manifest 缺失分支（02 §4）
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
    fn first_matching_rule_wins_and_is_reported() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        let (decision, rules) =
            PolicyHook::evaluate_with_trace(&p, &ctx("fs.read", EffectClass::Read, true));
        assert_eq!(decision, PolicyDecision::Allow);
        assert_eq!(rules, vec!["read-is-free".to_owned()]);
    }
}
