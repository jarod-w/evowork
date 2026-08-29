use clap::{Parser, Subcommand};
use evo_daemon::{replay_to, verify};
use evo_runlog::RunLog;
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
                let mut log = match RunLog::open(path, &blob_root) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("打不开 {}：{e}", path.display());
                        failed = true;
                        continue;
                    }
                };
                if drop_snapshots {
                    match log.clear_snapshots() {
                        Ok(n) => println!("{}：删除 {n} 个快照", path.display()),
                        Err(e) => {
                            eprintln!("{}：删快照失败 {e}", path.display());
                            failed = true;
                            continue;
                        }
                    }
                }
                let run_ids = match log.run_ids() {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("{}：读 run 列表失败 {e}", path.display());
                        failed = true;
                        continue;
                    }
                };
                for run_id in run_ids {
                    if do_verify {
                        match verify(&log, &run_id) {
                            // 「一个 checkpoint 都没检查到」不是通过。把它显示成
                            // 绿色的 OK，等于让 CI 每次都打印一行骗人的绿字。
                            Ok(report) if report.is_vacuous() => {
                                failed = true;
                                eprintln!(
                                    "VACUOUS {} {run_id}  Log 里没有 checkpoint，什么都没验到",
                                    path.display()
                                );
                            }
                            Ok(report) if report.is_ok() => println!(
                                "OK   {} {run_id}  checkpoints={} final={}",
                                path.display(),
                                report.checkpoints_checked,
                                &report.final_state_hash[..16]
                            ),
                            Ok(report) => {
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
                            Err(e) => {
                                failed = true;
                                eprintln!("FAIL {} {run_id}：{e}", path.display());
                            }
                        }
                    } else {
                        match replay_to(&log, &run_id, None, !drop_snapshots) {
                            Ok(state) => println!(
                                "{} {run_id}  status={:?} turn={} last_seq={}",
                                path.display(),
                                state.status,
                                state.turn,
                                state.last_seq
                            ),
                            Err(e) => {
                                failed = true;
                                eprintln!("FAIL {} {run_id}：{e}", path.display());
                            }
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
