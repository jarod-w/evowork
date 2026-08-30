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
///
/// 真实路径校验也不是最后一道：硬链接根本没有「另一条真实路径」可供
/// canonicalize 跟随，前缀比对对它永远成立，见 [`reject_hard_linked_file`]。
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
///
/// 「已存在」判断不能用 `Path::exists`：它是 `stat`，会跟随符号链接，
/// 对一个指向尚不存在目标的**悬空符号链接**会返回 `false`。这会把
/// 「这里真的什么都没有」和「这里有一个软链节点，只是它指向的东西还
/// 不存在」混为一谈——后者应当在这一层就被识别为已存在、拿去
/// `canonicalize`（进而因为目标不存在而报错拒绝），而不是被当成空气
/// 继续向上剥，剥到工作区根、判定“安全”，实际写入却由内核跟随软链
/// 落到工作区之外。这里改用 `symlink_metadata`（`lstat`，只探测路径
/// 本身，不跟随它自己这一层的符号链接），悬空软链节点也能被正确认作
/// “已存在”。
fn resolve_through_symlinks(
    ws: &WorkspaceHandle,
    lexical: &Path,
    rel: &str,
) -> Result<PathBuf, ExecError> {
    let ws_root = ws.path();

    let mut existing = lexical.to_path_buf();
    let mut trailing: Vec<std::ffi::OsString> = Vec::new();
    while existing.symlink_metadata().is_err() {
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
    reject_hard_linked_file(&real_ancestor, rel)?;

    let mut resolved = real_ancestor;
    for part in trailing {
        resolved.push(part);
    }
    Ok(resolved)
}

/// 硬链接逃逸：`canonicalize` 在这里帮不上任何忙。
///
/// 符号链接是一个**指向另一条路径**的节点，所以「真实路径」这个概念成立，
/// canonicalize 能把它跟到底。硬链接不是：它就是同一个 inode 的第二个
/// 目录项，两个名字之间没有主次、没有指向关系，各自都是「真实路径」。
/// 工作区内的 `innocent.txt` 与工作区外的 `outside-secret.txt` 硬链到同一
/// 个 inode 时，`innocent.txt` canonicalize 出来还是 `<ws>/innocent.txt`
/// ——前缀比对干干净净地通过，而 `fs::write` 落笔改的是那个 inode 的内容，
/// 工作区外那个名字看到的数据同样被改写了。更糟的是 `actual_targets` 报出
/// 来的是一条合法的工作区相对路径：`executor.rs` 那段「declared 与 actual
/// 比对」的供应链行为异常检测在这个场景下拿到的是伪证。
///
/// 能拿到的唯一信号是 `nlink`：`nlink > 1` 说明这个 inode 还有别的名字。
/// **它说不出别的名字在哪儿**——要说得出，只能扫遍所有可能的挂载点去找
/// 同 inode 的目录项，每次 `fs.write` 一遍，代价不可接受（工作区里放一个
/// 几万文件的仓库是常态）。所以这里采取保守判定：目标是普通文件且
/// `nlink > 1` 就拒。
///
/// 两个必须写清楚的边界：
///
///   1. **只对普通文件判。** 目录的 `nlink` 天然 ≥ 2（`.` 自己算一个，
///      每个子目录的 `..` 再各算一个），拿目录去比 `nlink > 1` 会把每个
///      工作区都判成逃逸。Linux 也不允许对目录建硬链接，所以只看
///      `is_file()` 不留口子。判定对象是 canonicalize 之后的真实祖先：
///      如果先经过一条工作区内的软链再落到一个硬链接文件上，
///      `symlink_metadata` 拿到的会是软链自己的 `nlink`（恒为 1），
///      必须在解析之后再看。
///   2. **会误伤工作区内部两个互为硬链接的文件。** 这是有意接受的代价。
///      工作区是每个 run 独享的临时目录，内容全部由这次 run 自己产生，
///      内部互为硬链接的两个文件既罕见又总有等价写法（写到新路径，或先
///      `rm` 再写）。反过来，最常见的「工作区里出现硬链接」恰恰是危险
///      的那一类——比如包管理器把全局 store 里的文件硬链进 node_modules，
///      对它写入损坏的是 store 而不是工作区。宁可拒一种几乎没人依赖的
///      写法，也不放行一条落点无法判定的路径；这与悬空软链那次的取舍
///      是同一条原则。
///
/// 残余风险（本轮不修，属另一类问题）：这仍是校验时刻的判断，挡不住
/// 「校验之后、`fs::write` 之前」有并发进程把目标换成硬链接的 TOCTOU。
/// 工作区内已有的符号链接防护是同一个时刻做的，同样有这个窗口——真要
/// 关掉它，得让写入路径改成 `O_NOFOLLOW` 打开、对同一个 fd `fstat` 再
/// 写，那是对 `executor.rs` 写入路径的改造，不在这条修复的范围里。
fn reject_hard_linked_file(real_ancestor: &Path, rel: &str) -> Result<(), ExecError> {
    use std::os::unix::fs::MetadataExt;

    // real_ancestor 已经 canonicalize 过，路径上不再有符号链接，
    // 这里的 symlink_metadata 与 metadata 等价。
    let md = real_ancestor.symlink_metadata()?;
    if md.is_file() && md.nlink() > 1 {
        return Err(ExecError::PathEscape(format!(
            "{rel}: hard link (nlink={}) — the same inode may have another name outside the workspace",
            md.nlink()
        )));
    }
    Ok(())
}
