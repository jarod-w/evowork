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
/// 这里先在**词法层**消解 `..`，再比对前缀——对尚不存在的路径同样成立。
///
/// 但词法层看不见符号链接：工作区里预先放一个指向工作区外的软链，
/// 词法消解会判定「合法」，真实文件却落在工作区之外。所以词法校验
/// 通过之后还要再做一遍**真实路径**校验，见 [`resolve_through_symlinks`]。
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

    let lexical = ws.path().join(&joined);
    resolve_through_symlinks(ws, &lexical, rel)
}

/// 词法校验只是第一道关：它按字符串消解 `..`，完全不看文件系统里
/// 每一层到底是普通目录还是符号链接。工作区内放一个指向工作区外的
/// 软链 `escape -> /outside`，词法层看到的仍然是 `<ws>/escape/x.txt`，
/// 前缀比对通过，但 `std::fs::write` 真正落笔时内核会跟随符号链接，
/// 文件实际写到 `/outside/x.txt`。
///
/// 这里补一层真实路径校验：从候选路径开始逐级向上剥掉还不存在的
/// 尾部分量，直到碰到**第一个已经存在的祖先**——这个祖先在文件系统里
/// 已经有真实身份了，可以安全地 `canonicalize`。canonicalize 会跟随
/// 它路径上出现的**每一层**符号链接（不只是最后一段），拿到的就是这个
/// 祖先的真实落地路径。只要这个真实路径还在（已经 canonicalize 过的）
/// 工作区根之内，整条路径就是安全的；最终返回的路径基于这个真实祖先
/// 重新拼出尾部分量，而不是可能穿过软链的候选路径——否则调用方（比如
/// `actual_targets`）报出来的仍然是一个看似合法、实际穿了软链的假路径。
///
/// 对尚不存在的目标文件依然可用：如果候选路径整条都不存在，逐级向上
/// 最终会落到工作区根本身——它在 `WorkspaceRoot::ensure` 里已经
/// canonicalize 过，一定存在、一定在根内，循环必然终止。
fn resolve_through_symlinks(
    ws: &WorkspaceHandle,
    lexical: &Path,
    rel: &str,
) -> Result<PathBuf, ExecError> {
    let ws_root = ws.path();

    let mut existing = lexical.to_path_buf();
    let mut trailing: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let popped = existing.file_name().map(|name| name.to_os_string());
        if !existing.pop() {
            break;
        }
        if let Some(name) = popped {
            trailing.push(name);
        }
    }
    trailing.reverse();

    let real_ancestor = existing.canonicalize()?;
    if !real_ancestor.starts_with(ws_root) {
        return Err(ExecError::PathEscape(rel.to_owned()));
    }

    let mut resolved = real_ancestor;
    for part in trailing {
        resolved.push(part);
    }
    Ok(resolved)
}
