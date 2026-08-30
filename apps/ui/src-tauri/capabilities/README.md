# `default.json` -- why each permission is here

Tauri 2's IPC layer is default-deny: `RuntimeAuthority::resolve_access`
builds its `allowed_commands` set entirely from resolved capabilities, and
this directory used to not exist at all. With no capability files to glob,
Tauri silently resolves an **empty** permission set -- no error at compile
time, no error in `tauri.conf.json5`, just every plugin command rejected
with `command not allowed` the first time the frontend actually calls one
on a real machine. `default.json` is the fix: it is the sole capability
file for this app, and it grants only the specific plugin commands that
`../../src/platform/tauri.ts`'s five `Platform` methods actually call --
not any plugin's `*:default` permission set, which would grant strictly
more than this shell uses.

Each permission below is named for the exact `Platform` method(s) that
need it. If a permission has no method still using it, delete the
permission (and this line) together -- an orphaned grant is unused attack
surface. `src/platform/tauri.capabilities.test.ts` enforces both
directions automatically, not just as a manual reminder: it fails if any
`.ts` file under `platform/` calls a plugin command with no matching
permission here, *and* it fails if this file grants a permission that no
file under `platform/` actually uses any more (the orphan case this
paragraph describes) -- both directions have a passing-then-failing
counter-example recorded in `.superpowers/sdd/final-review-fix-report.md`.

| Permission | Needed by | Why |
|---|---|---|
| `dialog:allow-open` | `pickFile()` | Opens the native OS file-picker dialog (`@tauri-apps/plugin-dialog`'s `open()`, which invokes the plugin's `open` command). |
| `fs:allow-read-file` | `pickFile()` | Reads the bytes of the path the dialog returned, via `@tauri-apps/plugin-fs`'s `readFile()` (the plugin's `read_file` command), so `pickFile()` can hand back a web `File`/`Blob` like the `Platform` interface promises. |
| `opener:allow-open-url` | `openExternal()` | Hands a URL to the OS's default handler via `@tauri-apps/plugin-opener`'s `openUrl()` (the plugin's `open_url` command). |
| `notification:allow-is-permission-granted` | `notify()` | Checks whether notification permission is already granted (the notification plugin's `window.Notification` shim routes this to its `is_permission_granted` command). |
| `notification:allow-request-permission` | `notify()` | Prompts for notification permission if not already granted (routes to the `request_permission` command). |
| `notification:allow-notify` | `notify()` | Actually shows the notification (`sendNotification()` routes to the `notify` command). |
| `autostart:allow-enable` | `setAutoLaunch(true)` | Registers the app to launch at login (`@tauri-apps/plugin-autostart`'s `enable()`). |
| `autostart:allow-disable` | `setAutoLaunch(false)` | Un-registers the app from launching at login (`disable()`). |
| `process:allow-exit` | `quit()` | Terminates the app process (`@tauri-apps/plugin-process`'s `exit()`, the `exit` command). |

## No `fs` scope is configured here, on purpose

`pickFile()` does not get a static, standing filesystem scope -- no
`fs:scope` entry, no directory grant. Tauri's dialog plugin handles this
dynamically: after a successful pick, its `open` command handler calls
`window.try_fs_scope().allow_file(&path)` on the *specific path the user
just chose* (see `tauri-plugin-dialog`'s `src/commands.rs`), which is what
makes the subsequent `fs:allow-read-file` call succeed for that one file.
Granting `pickFile()` a broader static `fs` scope instead would work
mechanically, but would hand this desktop shell a standing grant to browse
the filesystem well beyond the one round-trip it actually performs --
undermining the product's "data does not leave the local network"
positioning for no functional benefit.

## Not verified on a real machine

Nothing in this repository can run a real Tauri IPC round-trip (`cargo
check` does not even build on this Linux dev box -- see
`../Cargo.toml`'s comment). Every permission identifier above was checked
by hand against the actual `permissions/*.toml` files shipped in the
`tauri-plugin-*` crate sources (not guessed from memory or docs), and
`src/platform/tauri.capabilities.test.ts` keeps this file's permission
list mechanically in sync with `platform/tauri.ts`'s plugin calls -- but
neither of those substitutes for actually launching the app on macOS and
exercising each of the five `Platform` methods once.
