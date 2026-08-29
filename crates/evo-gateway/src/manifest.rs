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
    /// 从参数里解出这个 target 声明指向的资源。
    ///
    /// `FromParam` 的语法（是不是一个以 `/` 开头的 JSON Pointer）在加载期就由
    /// `ManifestRegistry::from_toml_str` 校验过了——笔误会让 manifest 直接加载
    /// 失败。但**语法合法、运行时参数里恰好没有那个字段**这半条，加载期查不出
    /// 来：这时这里返回 `None`，调用方（`impact.rs`、`pipeline.rs`）用
    /// `filter_map` 悄悄丢掉这个 target，它就不会出现在影响预估里。
    ///
    /// 这是有意接受的取舍，不是疏漏：manifest 和代码同仓、走 code review，
    /// 不是运行时的用户输入，笔误的主要入口已经被加载期校验挡住了；剩下这种
    /// "指针语法对、但这次调用的参数形状对不上"的情况，本质上更像是工具作者
    /// 对参数形状的假设有误，需要在 review 或联调时发现。**现在不做运行时
    /// 告警**：Gateway 按设计不持有任何存储或日志句柄（它只产出「要追加哪些
    /// 事件」，由 daemon 落盘），给 `resolve()` 加一条诊断通道意味着要么让
    /// Gateway 持有日志句柄（违反这条约束），要么把诊断塞进 `EventBody`
    /// 变成一等事件——这两者都值得做，但属于阶段 2 的事，不在这一轮范围内。
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
    /// `FromParam::from_param` 不是一个合法的 JSON Pointer 形态（没有以 `/`
    /// 开头，空字符串也算）。加载期就拒绝，挡住「忘了写斜杠」这类笔误——
    /// 不然它会在 `resolve()` 里静默返回 `None`，悄悄从影响预估里漏掉一个
    /// target（见 `TargetSpec::resolve` 的文档注释）。
    #[error(
        "tool `{tool}` 的 target 声明里 from_param `{pointer}` 不是合法的 JSON Pointer（必须以 '/' 开头）"
    )]
    InvalidPointer { tool: String, pointer: String },
}

pub struct ManifestRegistry {
    by_name: BTreeMap<String, ToolManifest>,
}

impl ManifestRegistry {
    pub fn from_toml_str(s: &str) -> Result<Self, ManifestError> {
        let file: ManifestFile = toml::from_str(s)?;
        for m in &file.methods {
            for t in &m.targets {
                if let TargetSpec::FromParam { from_param, .. } = t
                    && !from_param.starts_with('/')
                {
                    return Err(ManifestError::InvalidPointer {
                        tool: m.name.clone(),
                        pointer: from_param.clone(),
                    });
                }
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_from_param_pointer_missing_the_leading_slash_fails_to_load() {
        // 笔误（"path" 而不是 "/path"）不能留到 resolve() 时才静默返回 None，
        // 悄悄从影响预估里漏掉一个 target——必须在加载期就挡住。
        let bad = r#"
[[method]]
name = "fs.write"
class = "write"
targets = [{ from_param = "path", kind = "file", op = "update" }]
"#;
        let Err(err) = ManifestRegistry::from_toml_str(bad) else {
            panic!("expected loading a manifest with a bare (no leading slash) from_param to fail");
        };
        match err {
            ManifestError::InvalidPointer { tool, pointer } => {
                assert_eq!(tool, "fs.write");
                assert_eq!(pointer, "path");
            }
            other => panic!("expected InvalidPointer, got {other:?}"),
        }
    }
}
