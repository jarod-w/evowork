// evowork desktop shell.
//
// This file is deliberately thin: start a window, load the frontend
// build, register the official Tauri plugins that back the five
// `platform/tauri.ts` methods. That is the whole job.
//
// What this file does NOT do, on purpose (design doc 06 §6 / M1 task 3
// brief): no `#[tauri::command]` -- no custom IPC surface for the
// frontend to call into, because there is no business logic here to
// expose. No Run Log access, no SQLite, no dependency on any `evo-*`
// crate. The reason Tauri was chosen over Electron in the first place is
// that this process has no Node in it -- nothing to run a copy of
// daemon/kernel logic in even if someone were tempted to. Keeping this
// file empty of business logic is what makes "swap the shell" mean
// "rewrite platform/tauri.ts", not "rewrite the app".
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // One `.plugin(...)` per capability `platform/tauri.ts` calls
        // into (see that file's module comment for the method -> plugin
        // mapping). Registering an official, off-the-shelf plugin is
        // shell wiring -- the plugin's own commands are invoked by name
        // from the JS side (`plugin:dialog|open` etc.), so omitting a
        // registration here would surface as a runtime "plugin not
        // found" error in the frontend, not a compile error.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // `MacosLauncher::LaunchAgent` registers autostart via a user
        // LaunchAgent plist on macOS (the delivery target) rather than
        // an AppleScript login item; `None` means "launch with no extra
        // CLI args" (the shell doesn't take any).
        //
        // NOT VERIFIED ON THIS MACHINE (see Cargo.toml): this is the one
        // line in this file most likely to need a small signature fix
        // the first time this actually compiles, if the crate's API has
        // moved since this was written by hand against its docs.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .run(tauri::generate_context!())
        .expect("error while running the evowork desktop shell");
}
