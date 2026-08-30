use async_trait::async_trait;
use evo_exec::{CommandSpec, EgressPolicy, ExecError, Sandbox, SandboxOutput, WorkspaceHandle};
use std::path::Path;
use tokio::process::Command;

/// Linux 开发机上的沙箱实现：工作区级隔离 + 强制走 proxy。
///
/// **不做内核级隔离**——那是 macOS seatbelt 实现的事（08 §3）。这句话
/// 覆盖的不只是文件系统：工作区外的文件逃逸、不受 proxy 约束的网络
/// 连接、以及子进程能拿到的一切进程能力（改权限、`cd` 到任意目录、
/// 读取白名单之外的敏感文件……），这三类问题在 Linux 开发机上都**没有**
/// 被挡住，全部留给 seatbelt / Landlock / namespace 这类内核级手段（见
/// 下面 `ALLOWED_PROGRAMS` 的文档注释——这不是本节的推测，是 code
/// review 实测跑通的结论）。但行为语义与 seatbelt 版一致（同一张隔离
/// 矩阵，05 §3），因此沙箱行为的测试可以复用：换实现时换的是隔离手段，
/// 不是断言。
pub struct WorkspaceOnlySandbox;

/// PATH 安全决策（M2 Task 5）。
///
/// `spawn` 里的 `cmd.env_clear()` 之后子进程默认没有 `PATH`，任何非绝对
/// 路径的程序名都会 spawn 失败——这不是 bug，是此前一直没做的一个决定。
/// 摆在面前的是两个选项：
///
///   1. **透传调用方（宿主机）的 PATH。** 方便，命令都能跑起来，但等于
///      把宿主机上任意可执行文件都带进了沙箱——模型让 Agent 跑什么就能
///      跑什么。
///   2. **给一份固定的程序名白名单 + 固定 PATH。** 严格，需要维护，
///      白名单外的命令会直接失败（模型可能因此重试几次，浪费几个
///      token）。
///
/// **这里选 2**——但要老实说清楚选它是为了什么，因为它做不到的事比
/// 看起来多：白名单只检查 `spec.program` 这一层，管不了那个程序随后
/// exec 什么。白名单里就有 `sh` / `bash` / `python3` / `node`，四个都
/// 能执行任意代码；code review 已经逐条实测：经由它们，`rm -rf` 真的
/// 删了工作区内的文件、`python3 -c "open(...).write(...)"` 真的写到了
/// 工作区外、`curl` 真的发出一次不经 proxy 的请求并拿到 200、`cd / &&
/// pwd` 证明进程能把 cwd 换到任意目录。也就是说，这份白名单**挡不住**
/// 「改权限、发起不受 proxy 约束的连接、读取白名单之外的敏感文件」
/// ——只要模型愿意先调一层解释器。真正堵这些口子要靠内核级隔离（见上面
/// struct 文档注释），不是这一层能做到的事。
///
/// 那选白名单的理由是什么？三条站得住的：
///
///   1. **挡住"顺手"而非"有意"。** 模型直接吐 `program: "rm"` 会拿到
///      一个结构化的拒绝（`ExecError::ProgramNotAllowed`），而不是静默
///      跑起来——这类误用远比刻意绕过常见。
///   2. **给审计一份清单。** "这个 Agent 能直接调用哪些程序名"是财务
///      客户安全评审会当场会问的问题，`ALLOWED_PROGRAMS` 就是那份
///      有据可依的答案——虽然答案里包含几个解释器，回答时不能含糊。
///   3. **意图信号。** 模型在 `rm` 被拒之后转而调 `sh -c 'rm ...'`，
///      是一次可见的升级动作：日志里"先试裸命令、被拒后套一层壳"
///      这个序列本身就是信号——拦不住，但看得见。
///
/// 相比之下，透传调用方（宿主机）PATH 那个选项（选项 1）连这三条都拿
/// 不到——它是"什么都不挡，也什么信号都不给"。这才是选 2 的真正依据，
/// 不是"选 2 挡住了越权"——它没有。维护这份名单的成本，和"模型偶尔
/// 重试一次不在名单里的命令"这两笔代价都是可接受的；放行任意二进制
/// 换来的是连这三条弱保证都没有。
///
/// 覆盖范围刻意保守：常见的文本处理 / 文件浏览 / 基础脚本解释器。不包含
/// 任何能直接提权、发起原始网络连接、或删除数据的程序名（`rm` /
/// `curl` / `wget` / `nc` / `chmod` / `chown` / `ssh` / `sudo` / `dd`
/// 都不在其中）——**但这只挡住了把这些名字直接放进 `spec.program` 的
/// 直接调用**：`sh -c 'rm ...'` / `python3 -c "..."` 这类经由白名单内
/// 解释器的间接调用，rm/curl/chmod 能做的事一样能做到，上面已逐条
/// 实测确认。真的需要这些能力、并且需要真正挡住时，应该做成具名的
/// `fs.*` / `http.*` 工具，走各自的 manifest 治理（可精确声明
/// targets/egress，并配合内核级隔离），而不是指望从 `shell.exec` 这个
/// 大口子里的程序名白名单拿到这种保证。
const ALLOWED_PROGRAMS: &[&str] = &[
    "sh", "bash", "echo", "cat", "ls", "pwd", "grep", "sed", "awk", "head", "tail", "wc", "sort",
    "uniq", "cut", "find", "mkdir", "cp", "mv", "python3", "node", "true", "false", "date", "env",
    "printf", "which", "diff", "tr", "basename", "dirname",
];

/// 子进程解析裸程序名时用的固定 PATH——**不是调用方（宿主机）的
/// PATH**。上面的白名单已经把"哪些程序名可以被直接 spawn"锁定了
/// （间接调用不受此约束，见上方 `ALLOWED_PROGRAMS` 的说明），这里
/// 只需要给一个能找到这些程序的最小系统目录集合，不需要再额外收窄。
const SANDBOX_PATH: &str = "/usr/bin:/bin:/usr/local/bin";

/// 只看程序名的最后一段：哪怕调用方给的是一条绝对路径
/// （比如 `/opt/evil/rm`），也不能靠换个目录绕开白名单——挡的是
/// "这个名字是否被允许跑"，不是"这条路径本身在不在系统标准目录里"。
fn program_allowed(program: &str) -> bool {
    let name = Path::new(program)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(program);
    ALLOWED_PROGRAMS.contains(&name)
}

impl WorkspaceOnlySandbox {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WorkspaceOnlySandbox {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Sandbox for WorkspaceOnlySandbox {
    async fn spawn(
        &self,
        spec: &CommandSpec,
        ws: &WorkspaceHandle,
        egress: &EgressPolicy,
    ) -> Result<SandboxOutput, ExecError> {
        if !program_allowed(&spec.program) {
            return Err(ExecError::ProgramNotAllowed(spec.program.clone()));
        }
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        cmd.current_dir(ws.path());
        // 子进程继承同一 profile 与 proxy 设置（05 §3）
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if let Some(addr) = &egress.proxy_addr {
            cmd.env("HTTP_PROXY", addr);
            cmd.env("HTTPS_PROXY", addr);
            cmd.env("http_proxy", addr);
            cmd.env("https_proxy", addr);
            // 没有它，很多客户端会绕过 proxy 直连
            cmd.env("NO_PROXY", "");
        }
        // 固定 PATH，放在最后设置——保证它不会被上面 `spec.env` 里
        // 可能出现的同名键覆盖掉。见上面 ALLOWED_PROGRAMS 的决策说明：
        // 这不是图方便的默认值，是安全边界的一部分。
        cmd.env("PATH", SANDBOX_PATH);
        let out = cmd.output().await?;
        Ok(SandboxOutput {
            exit_code: out.status.code().unwrap_or(-1),
            stdout: out.stdout,
            stderr: out.stderr,
        })
    }

    fn kind(&self) -> &'static str {
        "workspace-only"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_on_the_allowlist_is_allowed() {
        assert!(program_allowed("echo"));
    }

    #[test]
    fn a_program_off_the_allowlist_is_refused() {
        assert!(!program_allowed("curl"));
        assert!(!program_allowed("rm"));
    }

    #[test]
    fn an_absolute_path_cannot_smuggle_a_disallowed_program_past_the_allowlist() {
        // 白名单挡的是"这个名字是否被允许跑"，不是"这条路径在不在系统
        // 标准目录里"——换个目录不能绕开它。
        assert!(!program_allowed("/opt/evil/rm"));
        // 反过来，一条指向被允许程序的绝对路径应该照样放行——挡的是
        // 程序名，不是"必须用裸名字"。
        assert!(program_allowed("/usr/bin/echo"));
    }
}
