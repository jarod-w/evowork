use async_trait::async_trait;
use evo_exec::{CommandSpec, EgressPolicy, ExecError, Sandbox, SandboxOutput, WorkspaceHandle};
use std::path::Path;
use tokio::process::Command;

/// Linux 开发机上的沙箱实现：工作区级隔离 + 强制走 proxy。
///
/// **不做内核级隔离**——那是 macOS seatbelt 实现的事（08 §3）。
/// 但行为语义与 seatbelt 版一致（同一张隔离矩阵，05 §3），
/// 因此沙箱行为的测试可以复用：换实现时换的是隔离手段，不是断言。
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
/// **这里选 2。** 判断依据：这个沙箱在 Linux 开发机上是唯一的隔离
/// 边界——不像 macOS 交付形态那样还有 seatbelt 兜底（见上面 struct 的
/// 文档注释）；而 M2 之后紧接着要接入真实模型（DeepSeek key 已到位），
/// 也就是说很快就会是一个真实的模型在决定"跑什么命令"，不再是写测试
/// 用例的人。「文件读写与命令执行不出本机，是可验证的承诺」这句话如果
/// 只覆盖网络出口（proxy allowlist）和工作区边界（cwd），却放行"任意
/// 宿主机二进制都能被模型间接调用"，这个承诺就只兑现了一半：本机上能
/// 做的破坏——改权限、发起不受 proxy 约束的连接（不是所有程序都认
/// `HTTP_PROXY` 环境变量）、读取白名单之外的敏感文件——一样没被挡住，
/// 而这些恰恰是财务客户安全评审会当场会问的问题。维护这份名单的成本，
/// 和"模型偶尔重试一次不在名单里的命令"这两笔代价都是可接受的；放行
/// 任意二进制换来的是一旦出事就拿不回来的信任。
///
/// 覆盖范围刻意保守：常见的文本处理 / 文件浏览 / 基础脚本解释器。不包含
/// 任何能直接提权、发起原始网络连接、或删除数据的程序名（`rm` /
/// `curl` / `wget` / `nc` / `chmod` / `chown` / `ssh` / `sudo` / `dd`
/// 都不在其中）——真的需要这些能力时应该做成具名的 `fs.*` / `http.*`
/// 工具，走各自的 manifest 治理（可精确声明 targets/egress），而不是从
/// `shell.exec` 这个大口子里蹭一条命令出去。
const ALLOWED_PROGRAMS: &[&str] = &[
    "sh", "bash", "echo", "cat", "ls", "pwd", "grep", "sed", "awk", "head", "tail", "wc", "sort",
    "uniq", "cut", "find", "mkdir", "cp", "mv", "python3", "node", "true", "false", "date", "env",
    "printf", "which", "diff", "tr", "basename", "dirname",
];

/// 子进程解析裸程序名时用的固定 PATH——**不是调用方（宿主机）的
/// PATH**。上面的白名单已经把"能跑什么"锁死了，这里只需要给一个能
/// 找到这些程序的最小系统目录集合，不需要再额外收窄。
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
