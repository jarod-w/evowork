# `default.json` -- why each permission is here

Tauri 2's IPC layer is default-deny: `RuntimeAuthority::resolve_access`
builds its `allowed_commands` set entirely from resolved capabilities, and
this directory used to not exist at all. With no capability files to glob,
Tauri silently resolves an **empty** permission set -- no error at compile
time, no error in `tauri.conf.json5`, just every plugin command rejected
with `command not allowed` the first time the frontend actually calls one
on a real machine. `default.json` is the fix: it is the sole capability
file for this app, and it grants only the specific plugin commands that
`../../src/platform/tauri.ts`'s six `Platform` methods actually call --
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
| `fs:allow-read-text-file` **+ a one-file scope** | `readClientToml()` | Reads `$HOME/.evowork/client.toml` -- the token and URL `evo-daemon` writes on first run -- via `readTextFile()` (the plugin's `read_text_file` command). **This is the one grant in this file that carries a static scope**; see the section below for why it has to, and why it is a single literal filename. |
| `opener:allow-open-url` | `openExternal()` | Hands a URL to the OS's default handler via `@tauri-apps/plugin-opener`'s `openUrl()` (the plugin's `open_url` command). |
| `notification:allow-is-permission-granted` | `notify()` | Checks whether notification permission is already granted (the notification plugin's `window.Notification` shim routes this to its `is_permission_granted` command). |
| `notification:allow-request-permission` | `notify()` | Prompts for notification permission if not already granted (routes to the `request_permission` command). |
| `notification:allow-notify` | `notify()` | Actually shows the notification (`sendNotification()` routes to the `notify` command). |
| `autostart:allow-enable` | `setAutoLaunch(true)` | Registers the app to launch at login (`@tauri-apps/plugin-autostart`'s `enable()`). |
| `autostart:allow-disable` | `setAutoLaunch(false)` | Un-registers the app from launching at login (`disable()`). |
| `process:allow-exit` | `quit()` | Terminates the app process (`@tauri-apps/plugin-process`'s `exit()`, the `exit` command). |

## The `fs` scope: exactly one file, and `pickFile()` still gets none

Until 2026-09-01 this section said "No `fs` scope is configured here, on
purpose". That is no longer true, so it has been rewritten rather than
left standing next to a file that contradicts it. What changed and what
did not:

**`pickFile()` still gets no static scope, for the original reason.**
Tauri's dialog plugin handles it dynamically: after a successful pick, its
`open` command handler calls `window.try_fs_scope().allow_file(&path)` on
the *specific path the user just chose* (see `tauri-plugin-dialog`'s
`src/commands.rs`), which is what makes the subsequent
`fs:allow-read-file` call succeed for that one file. Granting `pickFile()`
a broader static `fs` scope instead would work mechanically, but would
hand this desktop shell a standing grant to browse the filesystem well
beyond the one round-trip it actually performs -- undermining the
product's "data does not leave the local network" positioning for no
functional benefit.

**`readClientToml()` gets one, because nothing can grant it dynamically.**
It reads a path the *code* chose (`$HOME/.evowork/client.toml`), not one a
user picked through a plugin that widens the scope as a side effect. With
no scope entry the grant is worse than useless: the IPC call is allowed
through, and the fs plugin then rejects the path -- a silent runtime
failure on a real machine that compiles, launches, and passes every other
check in this repo. So the entry is there, in the narrowest form the
plugin supports:

```json
{ "identifier": "fs:allow-read-text-file", "allow": ["$HOME/.evowork/client.toml"] }
```

Three properties of that shape are deliberate:

1. **One literal filename, no glob.** Not `$HOME/.evowork/**`, not
   `$HOME/**`. The shell can read that one file and nothing else.
2. **Attached to the permission, not to `fs:scope`.** `fs:scope` is the
   fs plugin's *global* scope -- an entry there would also apply to
   `fs:allow-read-file` (and to every other fs command a future change
   grants). Attaching the scope to `fs:allow-read-text-file` makes it a
   `CommandScope`, so only `read_text_file` can use it. `tauri-plugin-fs`
   2.5.1 honours this: every command in its `src/commands.rs` takes both
   `GlobalScope<Entry>` and `CommandScope<Entry>`.
3. **`read_text_file`, not `read_file`.** `pickFile()` already holds
   `fs:allow-read-file`, and reusing it would have put the scope on the
   command that handles arbitrary user-picked paths. Using the *other*
   read command keeps the two capabilities from sharing any grant.

Standing authority did go from "nothing" to "one file". That is the price
of P0-17's fix (the packaged `.app` shipping an empty daemon token and no
way to correct it after install); the alternative on the table was
bundling the daemon as a sidecar, which is a strictly larger change to
this shell's responsibilities. `src/platform/tauri.capabilities.test.ts`
asserts the scope entry is present and contains that exact path, so
someone "simplifying" the object entry back to a bare string fails a
test instead of shipping a silently broken auto-detect.

## Not verified on a real machine

Nothing in this repository can run a real Tauri IPC round-trip (`cargo
check` does not even build on this Linux dev box -- see
`../Cargo.toml`'s comment). Every permission identifier above was checked
by hand against the actual `permissions/*.toml` files shipped in the
`tauri-plugin-*` crate sources (not guessed from memory or docs), and
`src/platform/tauri.capabilities.test.ts` keeps this file's permission
list mechanically in sync with `platform/tauri.ts`'s plugin calls -- but
neither of those substitutes for actually launching the app on macOS and
exercising each of the six `Platform` methods once.

**2026-09-01 update.** The app has now been built and launched on macOS
(see `docs/STATUS.md` §二), which retires the "cannot run on this Linux
dev box" framing above -- but not the gap it describes: launching the
window is not the same as exercising a capability. As of that date the
only `Platform` method observed against a real IPC round-trip is none of
them; the window came up and the daemon connection was the thing under
test. `readClientToml()`'s scope entry in particular is verified only
statically (identifier against the locked crate's `permissions/*.toml`
via `scripts/verify-tauri-permissions.sh`, path against the test), and a
scope that Tauri parses is not yet a scope that Tauri *accepts a read
through*. That one needs a real launch with a `~/.evowork/client.toml` in
place.
