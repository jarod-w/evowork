//! 常驻 daemon 进程：HTTP `/v1/rpc` + WS `/v1/events`。
//!
//! 仓库里另外两个二进制（`evo-cli` / `mkcase`）是命令行工具。本进程才是
//! 「daemon」这个名字在形态上的落地——此前 `evo-daemon` 只是 lib crate。

use clap::Parser;
use evo_daemon::{AppState, DaemonConfig, RealClock, Runtime, serve};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_model::FixtureAdapter;
use serde::Deserialize;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;

/// 没有 `--fixtures` 时用的最小模型：立刻 `finish`。探针页的 hello()
/// 不走模型；`run.create` 走这条路径时至少能跑完一条 run，而不是卡在
/// FixtureExhausted。
const DEFAULT_FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    {
      "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 8, "output": 4, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop",
      "latency_ms": 1
    }
  ]
}"#;

#[derive(Parser, Debug)]
#[command(
    name = "evo-daemon",
    about = "evowork daemon（HTTP /v1/rpc + WS /v1/events）"
)]
struct Args {
    /// 监听地址。UI 探针页默认连 4477。
    #[arg(long, default_value = "127.0.0.1:4477")]
    bind: SocketAddr,
    /// 数据目录：runlog.sqlite、blobs、client.toml。
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// 策略 / 工具 / 定价 toml 所在目录。默认 `./config`。
    #[arg(long)]
    config_dir: Option<PathBuf>,
    /// 覆盖自动生成的共享 token。不设则读（或首次写入）data_dir/client.toml。
    #[arg(long)]
    token: Option<String>,
    /// FixtureAdapter 的 JSON 文件。不设则用内置的立刻-finish 夹具。
    #[arg(long)]
    fixtures: Option<PathBuf>,
}

#[derive(Deserialize)]
struct ClientToml {
    token: String,
    #[allow(dead_code)]
    url: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir)?;
    let config_dir = args.config_dir.unwrap_or_else(|| PathBuf::from("config"));

    let bind = args.bind;
    let token = match args.token {
        Some(t) => {
            write_client_toml(&data_dir, &t, bind)?;
            t
        }
        None => load_or_create_token(&data_dir, bind)?,
    };
    if token.is_empty() {
        anyhow::bail!("token must not be empty (auth is part of the protocol, even on localhost)");
    }

    let policy_toml = std::fs::read_to_string(config_dir.join("policy.toml"))?;
    let tools_toml = std::fs::read_to_string(config_dir.join("tools.toml"))?;
    let pricing_toml = std::fs::read_to_string(config_dir.join("pricing.toml"))?;

    let config = DaemonConfig {
        db_path: data_dir.join("runlog.sqlite"),
        blob_root: data_dir.join("blobs"),
        workspace_root: data_dir.join("workspaces"),
        principal: "u-local".to_owned(),
        policy_toml,
        tools_toml,
        pricing_toml,
        context_profile: "default".to_owned(),
        egress_allow: Vec::new(),
        proxy_addr: None,
        budget: evo_protocol::BudgetSpec::default(),
    };

    let model = match args.fixtures {
        Some(path) => FixtureAdapter::from_path(&path)?,
        None => FixtureAdapter::from_json_str(DEFAULT_FIXTURES)?,
    };

    let runtime = Runtime::new(
        config,
        Arc::new(RealClock),
        Arc::new(model),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )?;
    let state = AppState::new(runtime, token.clone(), env!("CARGO_PKG_VERSION"));

    let listener = TcpListener::bind(bind).await?;
    let actual = listener.local_addr()?;
    eprintln!("evo-daemon listening on http://{actual}");
    eprintln!("  hello:  GET  /v1/hello");
    eprintln!("  rpc:    POST /v1/rpc");
    eprintln!("  events: WS   /v1/events?token=…");
    eprintln!(
        "  token written to {}",
        data_dir.join("client.toml").display()
    );

    serve(listener, state).await?;
    Ok(())
}

fn default_data_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".evowork");
    }
    PathBuf::from(".evowork")
}

fn client_toml_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("client.toml")
}

fn write_client_toml(
    data_dir: &std::path::Path,
    token: &str,
    bind: SocketAddr,
) -> anyhow::Result<()> {
    let path = client_toml_path(data_dir);
    let mut f = std::fs::File::create(&path)?;
    writeln!(f, "token = \"{token}\"")?;
    writeln!(f, "url = \"http://{bind}\"")?;
    Ok(())
}

fn load_or_create_token(data_dir: &std::path::Path, bind: SocketAddr) -> anyhow::Result<String> {
    let path = client_toml_path(data_dir);
    if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        let parsed: ClientToml = toml::from_str(&raw)?;
        if parsed.token.is_empty() {
            anyhow::bail!("{} has an empty token", path.display());
        }
        return Ok(parsed.token);
    }
    let token = random_token()?;
    write_client_toml(data_dir, &token, bind)?;
    Ok(token)
}

fn random_token() -> anyhow::Result<String> {
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(hex::encode(buf))
}
