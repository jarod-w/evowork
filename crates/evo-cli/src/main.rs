use clap::{Parser, Subcommand};
use evo_daemon::RunOutcome;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "evo-cli", about = "evowork 运维命令")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// 重放 Run Log，在每个 checkpoint 处比对 state_hash
    Replay {
        /// 比对 checkpoint 的 state_hash，不一致则退出码为 1
        #[arg(long)]
        verify: bool,
        /// 先删光快照再回放。用于验证「快照可丢弃」（CI 检查 8）
        #[arg(long)]
        drop_snapshots: bool,
        /// 一个或多个 runlog.sqlite
        #[arg(required = true)]
        paths: Vec<PathBuf>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Commands::Replay {
            verify: do_verify,
            drop_snapshots,
            paths,
        } => {
            let mut failed = false;
            for path in &paths {
                if !path.exists() {
                    eprintln!("找不到 Run Log：{}", path.display());
                    failed = true;
                    continue;
                }
                let blob_root = path
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("blobs");

                // evo-cli 自己不持有 RunLog——唯一允许打开它、读它、删它快照
                // 的入口是 evo_daemon::cli_replay（见该函数的文档）。
                let report =
                    match evo_daemon::cli_replay(path, &blob_root, do_verify, drop_snapshots) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("{}：{e}", path.display());
                            failed = true;
                            continue;
                        }
                    };
                if drop_snapshots {
                    println!(
                        "{}：删除 {} 个快照",
                        path.display(),
                        report.dropped_snapshots
                    );
                }

                for (run_id, outcome) in report.runs {
                    match outcome {
                        Ok(RunOutcome::Verified(report)) => {
                            // 「一个 checkpoint 都没检查到」不是通过。把它显示成
                            // 绿色的 OK，等于让 CI 每次都打印一行骗人的绿字。
                            if report.is_vacuous() {
                                failed = true;
                                eprintln!(
                                    "VACUOUS {} {run_id}  Log 里没有 checkpoint，什么都没验到",
                                    path.display()
                                );
                            } else if report.is_ok() {
                                println!(
                                    "OK verify path={} run={run_id} checkpoints={} final={}",
                                    path.display(),
                                    report.checkpoints_checked,
                                    report.final_state_hash
                                );
                            } else {
                                failed = true;
                                for m in &report.mismatches {
                                    eprintln!(
                                        "FAIL {} {run_id} seq={} 期望 {} 实得 {}",
                                        path.display(),
                                        m.seq,
                                        m.expected,
                                        m.actual
                                    );
                                }
                            }
                        }
                        Ok(RunOutcome::Replayed {
                            status,
                            turn,
                            last_seq,
                            final_state_hash,
                        }) => {
                            println!(
                                "OK replay path={} run={run_id} status={status:?} turn={turn} last_seq={last_seq} final={final_state_hash}",
                                path.display()
                            );
                        }
                        Err(e) => {
                            failed = true;
                            eprintln!("FAIL {} {run_id}：{e}", path.display());
                        }
                    }
                }
            }
            if failed {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
    }
}
