use evo_exec::{ExecError, WorkspaceHandle};
use evo_protocol::ids::RunId;
use std::path::{Component, Path, PathBuf};

/// 硬拦截的路径片段。**不是策略可放宽项**——
/// 策略引擎可以放宽目录权限，但这几个不在策略的可及范围内（05 §3）。
pub const SENSITIVE_PREFIXES: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/gcloud",
    "Library/Keychains",
];

/// 每个 run 一个工作区：~/.evowork/workspaces/<run_id>/
pub struct WorkspaceRoot {
    base: PathBuf,
}

impl WorkspaceRoot {
    pub fn new(base: PathBuf) -> Self {
        Self { base }
    }

    pub fn ensure(&self, run_id: &RunId) -> Result<WorkspaceHandle, ExecError> {
        let path = self.base.join(run_id.as_str());
        std::fs::create_dir_all(&path)?;
        // canonicalize 之后再交出去：后续的越界判断依赖一个已解析的真实路径
        let path = path.canonicalize()?;
        Ok(WorkspaceHandle::new(run_id.as_str(), path))
    }
}

/// 把工具给的相对路径解析成工作区内的绝对路径，越界即拒。
///
/// 不用 `canonicalize` 做校验：目标文件还不存在时它会失败。
/// 这里在**词法层**消解 `..`，再比对前缀——对尚不存在的路径同样成立。
pub fn resolve_in_workspace(ws: &WorkspaceHandle, rel: &str) -> Result<PathBuf, ExecError> {
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err(ExecError::PathEscape(rel.to_owned()));
    }

    let mut stack: Vec<String> = Vec::new();
    for comp in candidate.components() {
        match comp {
            Component::Normal(c) => stack.push(c.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                if stack.pop().is_none() {
                    return Err(ExecError::PathEscape(rel.to_owned()));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(ExecError::PathEscape(rel.to_owned()));
            }
        }
    }

    let joined = stack.join("/");
    for prefix in SENSITIVE_PREFIXES {
        if joined == *prefix || joined.starts_with(&format!("{prefix}/")) {
            return Err(ExecError::SensitivePath(joined));
        }
    }

    Ok(ws.path().join(joined))
}
