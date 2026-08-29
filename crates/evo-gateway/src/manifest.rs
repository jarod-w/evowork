use evo_protocol::effect::{EffectClass, EgressRef, ResourceOp, ResourceRef};
use evo_protocol::ids::ToolId;
use serde::Deserialize;
use std::collections::BTreeMap;

/// 目标资源怎么从参数里静态提取。工具作者写的是**声明**，不是治理代码。
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum TargetSpec {
    /// JSON Pointer 指向参数里的某个字段
    FromParam {
        from_param: String,
        kind: String,
        op: ResourceOp,
    },
    Literal {
        literal: String,
        kind: String,
        op: ResourceOp,
    },
}

impl TargetSpec {
    pub fn resolve(&self, params: &serde_json::Value) -> Option<(ResourceRef, ResourceOp)> {
        match self {
            Self::FromParam {
                from_param,
                kind,
                op,
            } => {
                let v = params.pointer(from_param)?.as_str()?;
                Some((
                    ResourceRef {
                        kind: kind.clone(),
                        id: v.to_owned(),
                    },
                    *op,
                ))
            }
            Self::Literal { literal, kind, op } => Some((
                ResourceRef {
                    kind: kind.clone(),
                    id: literal.clone(),
                },
                *op,
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ToolManifest {
    pub name: String,
    pub class: EffectClass,
    #[serde(default)]
    pub reversible: bool,
    #[serde(default)]
    pub targets: Vec<TargetSpec>,
    #[serde(default)]
    pub egress: Vec<EgressRef>,
    /// 声明了 preview 的工具在 dry-run 下能给出精确 diff（降级第 1 级）。
    /// 阶段 1 只读这个字段决定 precision，不真的调 preview。
    #[serde(default)]
    pub preview: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ManifestFile {
    #[serde(default, rename = "method")]
    methods: Vec<ToolManifest>,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub struct ManifestRegistry {
    by_name: BTreeMap<String, ToolManifest>,
}

impl ManifestRegistry {
    pub fn from_toml_str(s: &str) -> Result<Self, ManifestError> {
        let file: ManifestFile = toml::from_str(s)?;
        Ok(Self {
            by_name: file
                .methods
                .into_iter()
                .map(|m| (m.name.clone(), m))
                .collect(),
        })
    }

    pub fn from_path(p: &std::path::Path) -> Result<Self, ManifestError> {
        Self::from_toml_str(&std::fs::read_to_string(p)?)
    }

    pub fn get(&self, tool: &ToolId) -> Option<&ToolManifest> {
        self.by_name.get(tool.as_str())
    }

    /// 未提供 manifest 的工具按最严处理：External + 不可逆 + 需审批。
    ///
    /// **这个默认值是有意选成最严的**：忘记写 manifest 的后果是「多问一次人」，
    /// 不是「静默漏掉治理」。反过来设默认值是这类系统最常见的失误（02 §4）。
    pub fn strictest_default(tool: &ToolId) -> ToolManifest {
        ToolManifest {
            name: tool.as_str().to_owned(),
            class: EffectClass::External,
            reversible: false,
            targets: Vec::new(),
            egress: Vec::new(),
            preview: None,
        }
    }
}
