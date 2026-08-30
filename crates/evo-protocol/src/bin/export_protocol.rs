//! 把 evo-protocol 的类型写成 `packages/protocol/generated/`。
//!
//! ```
//! cargo run -p evo-protocol --bin export-protocol -- packages/protocol/generated
//! ```

fn main() {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "packages/protocol/generated".to_owned());
    let path = std::path::PathBuf::from(&out);
    if let Err(e) = evo_protocol::export_typescript(&path) {
        eprintln!("export-protocol: {e}");
        std::process::exit(1);
    }
    println!("wrote TypeScript bindings to {}", path.display());
}
