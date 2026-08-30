use crate::blob::BlobRef;
use crate::ids::{CiteId, EffectId, RunId, ToolId};
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectClass {
    Read,
    Write,
    External,
    Compute,
}

impl EffectClass {
    /// dry-run 下是否降级为 record-only。Read / Compute 照常执行，否则预估不准。
    pub fn suppressed_in_dry_run(self) -> bool {
        matches!(self, Self::Write | Self::External)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceOp {
    Read,
    Create,
    Update,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ResourceRef {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EgressRef {
    /// 绝大多数工具能在 manifest 里静态声明一个具体主机名（比如
    /// `http.get` 的目标 URL）。`shell.exec` 不行——命令行是任意的，
    /// manifest 只能声明「这次调用一定会经过 proxy，但具体连哪个主机
    /// 要等运行时才知道」。TOML 里用 `via = "proxy"` 而不是
    /// `host = "proxy"` 拼写这后一种情况，读起来才不会被误认成一个
    /// 真实主机名；两者落在同一个字段上（alias 而非新增变体），因为
    /// 对下游（impact 预估、actual_egress 比对）来说它们本来就是同一种
    /// 数据形状，只是可读性上值得区分拼法。
    #[serde(alias = "via")]
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// 能力令牌。POC 期只做 scope 字符串匹配（02 §2 步骤 ②）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityToken {
    pub subject: String,
    pub scopes: Vec<String>,
}

impl CapabilityToken {
    pub fn allows(&self, tool: &ToolId) -> bool {
        self.scopes.iter().any(|s| s == "*" || s == tool.as_str())
    }
}

/// Gateway 读得懂的「声明」，不是待执行的闭包（02 §1）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectRequest {
    pub effect_id: EffectId,
    pub run_id: RunId,
    pub turn: u32,
    pub tool: ToolId,
    pub params_ref: BlobRef,
    pub params_digest: String,

    // 以下由工具 manifest 静态推导，由 Gateway 在建请求时填入
    pub class: EffectClass,
    pub targets: Vec<ResourceRef>,
    pub egress: Vec<EgressRef>,
    pub reversible: bool,

    // 以下由 runtime 填入
    pub taint: TaintLevel,
    pub cites_referenced: Vec<CiteId>,
    pub capability: CapabilityToken,
}
