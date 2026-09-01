import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

// FORCING FUNCTION -- read before touching `platform/`,
// `../../src-tauri/capabilities/default.json`, or this file.
//
// Tauri 2's IPC is default-deny (see `src-tauri/capabilities/README.md`):
// a plugin command the frontend calls is only reachable if some
// capability grants the exact permission for it. A missing grant is NOT
// a compile error, and nothing in this repo's jsdom-based test suite can
// drive a real Tauri IPC round-trip to catch it either -- it only ever
// surfaces as a silent "command not allowed" the first time a button is
// pressed on a real machine. That is precisely the defect this test
// exists to prevent from recurring: `src-tauri/capabilities/` used to not
// exist at all, so all five `Platform` methods below were silently
// unreachable despite a clean build and a green test suite.
//
// This test statically cross-references two independent sources of truth
// against the hand-maintained manifest below:
//   1. Which `@tauri-apps/plugin-*` imports files under `platform/`
//      actually use, and which of their exports they actually reach
//      (parsed from a real TypeScript AST via the `typescript` compiler
//      API -- this file deliberately does not import those modules
//      itself, which would require mocking every plugin just to load
//      them).
//   2. Which permission identifiers `../../src-tauri/capabilities/default.json`
//      actually grants.
// Every plugin import a file under `platform/` makes MUST appear in the
// manifest below (an import missing from it means either the manifest
// went stale or a genuinely new capability was wired up without telling
// this test -- both must fail loudly), and the permission the manifest
// says that import needs MUST be present in the capability file.
// Symmetrically, every permission the capability file grants MUST map to
// a manifest entry that some file under `platform/` still actually uses
// -- an orphan grant (a permission nothing calls any more) is exactly as
// much of a drift bug as a missing one, and is real attack surface, not
// a harmless leftover. Concretely, this fails if any of these happens:
//   - a file under `platform/` gains a new plugin call with no
//     corresponding manifest entry (a new import shows up that
//     `PLUGIN_IMPORT_PERMISSIONS` doesn't know about).
//   - `capabilities/default.json` loses a permission that a
//     still-imported plugin call under `platform/` needs.
//   - `capabilities/default.json` grants a permission that no manifest
//     entry maps to, or that maps to a manifest entry nothing under
//     `platform/` imports any more (an orphan permission -- see below).
//
// Scans every `.ts` source file directly under `platform/` (excluding
// `*.test.ts` files, which are not shipped runtime code), not a single
// hardcoded filename. An earlier version of this test only ever read
// `./tauri.ts`, hardcoded by name -- a new file under `platform/` (e.g.
// `platform/extra.ts`) importing an ungranted plugin command sailed
// through 19/19 green, both directions, because the test simply never
// looked at it. That is the exact class of bug this test's own header
// warns about: "a silent pass on unrecognized code is exactly the bug
// this test exists to avoid reintroducing in a new shape" -- scoping the
// scan to one filename was that bug wearing a different shape. `tauri.ts`
// is expected to be the only file that actually imports plugin packages
// today (it is the one file in the repo allowed to, per its own
// file-level comment), but this test does not take that on faith -- it
// looks at every file and lets the AST walk prove it.
//
// AST, not regex -- and an explicit refusal, not a false "all clear",
// for anything an AST walk can't pin down:
//
// An earlier version of this test scraped `tauri.ts`'s source with a
// regex that only matched `import { a, b } from '@tauri-apps/plugin-x'`.
// That is silently blind to every other way JS/TS can reach a plugin
// export: `import * as ns from '...'` plus `ns.someCommand(...)`,
// `await import('@tauri-apps/plugin-x')`, a default import, etc. -- code
// using any of those forms would call an ungranted command and this test
// would still show all-green, precisely the class of "checks that can be
// silently walked around" this repo has already been bitten by once (see
// the CI-9 grep fix). Parsing a real AST via the `typescript` compiler
// API instead means named imports, namespace imports, and dynamic
// `import()` calls are all visible to the same walk, because they're all
// just node kinds in the same tree, not text patterns that have to each
// be separately guessed at.
//
// That said, some constructs are *inherently* not statically resolvable
// -- e.g. `ns[someVariable]()`, where the actual command name only exists
// at runtime. For those, `analyzeTauriPluginUsage` below does not attempt
// a best-effort guess and does not silently skip them either: it throws,
// naming the exact construct and telling the author to rewrite it as a
// direct import/property access instead. A test that can't verify a
// piece of code must say so loudly, not quietly report success anyway --
// a silent pass on unrecognized code is exactly the bug this test exists
// to avoid reintroducing in a new shape.

// `import.meta.url` is captured into a plain variable, rather than
// passed inline as `new URL('./x', import.meta.url)`, deliberately --
// Vite special-cases that exact inline-literal shape as an asset-URL
// reference and resolves it against the dev-server origin
// (`http://localhost:.../...`) instead of the real module file path when
// running under vitest's jsdom environment, which then fails
// `fileURLToPath()` below ("The URL must be of scheme file"). Breaking
// the pattern by going through a variable sidesteps that transform and
// gets the real `file://` URL both here and under `vitest run`.
const thisModuleUrl = import.meta.url
const platformDirUrl = new URL('.', thisModuleUrl)
const capabilitiesUrl = new URL('../../src-tauri/capabilities/default.json', thisModuleUrl)

const platformDirPath = fileURLToPath(platformDirUrl)

// A Tauri 2 capability's `permissions` array is heterogeneous: a plain
// string for an unscoped grant, or an object
// (`{ identifier, allow?, deny? }`) for one carrying a command scope.
// `capabilities/default.json` has held both since `fs:allow-read-text-file`
// gained a one-file scope for `readClientToml()` (P0-17).
//
// This distinction is not cosmetic to this test: before it was handled,
// every assertion below compared array elements against permission-name
// STRINGS, so an object entry silently matched nothing -- the orphan
// direction reported the scoped `fs:allow-read-text-file` as an
// unmapped permission, and the forward direction reported the grant as
// missing. Verified by adding the scoped entry before this change: 2
// failures, both naming `fs:allow-read-text-file`.
type CapabilityPermissionEntry = string | { identifier: string; allow?: unknown; deny?: unknown }

const capabilities = JSON.parse(readFileSync(fileURLToPath(capabilitiesUrl), 'utf-8')) as {
  permissions: CapabilityPermissionEntry[]
}

function permissionIdentifier(entry: CapabilityPermissionEntry): string {
  if (typeof entry === 'string') return entry
  if (typeof entry === 'object' && entry !== null && typeof entry.identifier === 'string') {
    return entry.identifier
  }
  throw new Error(
    `tauri.capabilities.test.ts: capabilities/default.json has a permissions entry that is neither a ` +
      `string nor an object with a string "identifier": ${JSON.stringify(entry)}. Tauri would reject this ` +
      `file at build time; this test refuses to guess what was meant rather than skipping the entry (a ` +
      `skipped entry is an ungranted-but-believed-granted permission, which is the exact failure mode this ` +
      `whole file exists to prevent).`,
  )
}

/**
 * Just the identifiers, for the assertions that only care about "is this
 * permission granted at all". The scope attached to an entry is checked
 * separately below -- see `SCOPE_REQUIRED_PERMISSIONS`.
 */
const grantedPermissionIdentifiers = capabilities.permissions.map(permissionIdentifier)

/**
 * Permissions that are useless -- silently, at runtime -- without a
 * static scope, and the scope entry each one must carry.
 *
 * `fs:allow-read-text-file` is the whole reason this list exists.
 * Granting the command alone compiles, launches, and passes every other
 * assertion in this file, then fails on a real machine with `forbidden
 * path` the first time `readClientToml()` runs, because the fs plugin's
 * scope defaults to empty and nothing widens it for a path the code (not
 * a dialog gesture) chose. `pickFile()`'s `fs:allow-read-file` is
 * deliberately NOT in this list: the dialog plugin grants a one-shot
 * scope for the picked path at runtime, so a static scope there would be
 * standing authority for no benefit (see capabilities/README.md).
 */
const SCOPE_REQUIRED_PERMISSIONS: ReadonlyArray<{ permission: string; allow: string; why: string }> = [
  {
    permission: 'fs:allow-read-text-file',
    allow: '$HOME/.evowork/client.toml',
    why: "platform/tauri.ts's readClientToml() reads a code-chosen path, so no dialog gesture widens the fs scope for it",
  },
]

// Every `.ts` source file directly under `platform/`, excluding
// `*.test.ts` (not shipped runtime code -- and excluding this file
// itself, which imports `typescript`/`vitest`/`node:fs`, none of which
// are `@tauri-apps/plugin-*` specifiers, so including it would be inert
// anyway). Sorted for a stable, deterministic test list across machines.
//
// Deliberately not recursive beyond this one directory: `platform/` has
// no subdirectories today, and the module-comment rule ("the one and
// only surface the UI is allowed to touch for native capabilities") is
// scoped to this directory specifically. If `platform/` ever grows
// subdirectories, extend this to recurse into them rather than silently
// leaving them unscanned.
const platformSourceFiles = readdirSync(platformDirPath, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
  .map((entry) => entry.name)
  .sort()

interface PluginBinding {
  module: string
  namedImport: string
}

// Manifest: every export any file under `platform/` pulls from a
// `@tauri-apps/plugin-*` package and reaches (whether via a named import
// or a namespace-import property access), and the exact capability
// permission identifier that export needs so it isn't rejected by the
// IPC allowlist at runtime. Keep this in lockstep with both `platform/`'s
// actual plugin usage and `capabilities/default.json`'s permission list
// -- the tests below fail if either one drifts from this manifest, in
// either direction (a used import missing a permission, or a granted
// permission nothing uses any more).
// `permission: null` means "this export is not an IPC command, so there
// is no permission to grant for it". Exactly one binding needs that
// today (`BaseDirectory`, a plain numeric enum the fs plugin's JS side
// passes through as an option field), and it is spelled out rather than
// filtered from the scan: an unrecognized import must still fail this
// test, and "not a command" is a claim that belongs written down next to
// the import it excuses. Marking a real command `null` would defeat the
// test -- no static check can prevent that, which is why it is a
// documented exception with a stated reason and not a general escape
// hatch.
const PLUGIN_IMPORT_PERMISSIONS: ReadonlyArray<PluginBinding & { permission: string | null }> = [
  { module: '@tauri-apps/plugin-dialog', namedImport: 'open', permission: 'dialog:allow-open' },
  { module: '@tauri-apps/plugin-fs', namedImport: 'readFile', permission: 'fs:allow-read-file' },
  { module: '@tauri-apps/plugin-fs', namedImport: 'readTextFile', permission: 'fs:allow-read-text-file' },
  {
    module: '@tauri-apps/plugin-fs',
    // Not a command: `BaseDirectory` is a numeric enum in the plugin's JS
    // package, passed as `readTextFile(path, { baseDir })` and resolved
    // inside the plugin's own `read_text_file` handler on the Rust side.
    // It issues no `invoke()` of its own, so there is no separate
    // permission identifier it could possibly need. (Reaching for
    // `@tauri-apps/api/path`'s `homeDir()` instead WOULD have been a real
    // second command -- and one this test cannot see, since it only
    // scans `@tauri-apps/plugin-*` specifiers. That is why tauri.ts uses
    // this enum.)
    namedImport: 'BaseDirectory',
    permission: null,
  },
  { module: '@tauri-apps/plugin-opener', namedImport: 'openUrl', permission: 'opener:allow-open-url' },
  {
    module: '@tauri-apps/plugin-notification',
    namedImport: 'isPermissionGranted',
    permission: 'notification:allow-is-permission-granted',
  },
  {
    module: '@tauri-apps/plugin-notification',
    namedImport: 'requestPermission',
    permission: 'notification:allow-request-permission',
  },
  {
    module: '@tauri-apps/plugin-notification',
    namedImport: 'sendNotification',
    permission: 'notification:allow-notify',
  },
  { module: '@tauri-apps/plugin-autostart', namedImport: 'enable', permission: 'autostart:allow-enable' },
  { module: '@tauri-apps/plugin-autostart', namedImport: 'disable', permission: 'autostart:allow-disable' },
  { module: '@tauri-apps/plugin-process', namedImport: 'exit', permission: 'process:allow-exit' },
]

const PLUGIN_MODULE_PREFIX = '@tauri-apps/plugin-'

function isPluginModuleSpecifier(text: string): boolean {
  return text.startsWith(PLUGIN_MODULE_PREFIX)
}

// Walks a real TypeScript AST of `source` (parsed as `fileName`, purely
// for diagnostics -- nothing is written back) and returns every
// (module, exported name) pair it can prove this file reaches inside a
// `@tauri-apps/plugin-*` package. "Reaches" means either:
//   - a named import (`import { a, b as c } from '...'` -> the plugin's
//     *exported* name, `a`/`b`, not the local alias `c`), or
//   - a namespace import used via a direct, non-computed property access
//     (`import * as ns from '...'` + `ns.someCommand(...)`).
//
// Anything this walk cannot pin down to a concrete export name throws,
// with a message identifying the exact line/column and construct, rather
// than silently omitting it from the returned list -- see the file-level
// comment above for why a confident-looking pass here would be worse
// than an explicit failure. Constructs that throw:
//   - a default import of a plugin module (`import x from '...'`): the
//     plugin's default export's shape isn't known to this test, so which
//     command a call through it reaches can't be determined here.
//   - a namespace import accessed via computed member access
//     (`ns[expr]`, including `ns['someCommand']` with a *string
//     literal* -- rewriting this test to also special-case that one
//     shape would just move the blind spot to `ns[cmd]` with a variable,
//     which is exactly the "build the command name from a variable"
//     bypass this function must refuse rather than wave through).
//   - a dynamic `import(...)` of a plugin module, or any dynamic
//     `import()` whose argument isn't a plain string literal: nothing
//     downstream of `await import(expr)` is walked for property access,
//     so a plugin call reached this way is invisible to this analysis.
//   - a re-export (`export * from '...'` / `export { x } from '...'`) of
//     a plugin module: files under `platform/` aren't expected to
//     re-export plugin internals, so treat it as unanalyzed rather than
//     assume it's dead.
function analyzeTauriPluginUsage(source: string, fileName: string): PluginBinding[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // local identifier name -> plugin module specifier, for
  // `import * as ns from '@tauri-apps/plugin-x'`.
  const namespaceImports = new Map<string, string>()
  // Dedupes {module, namedImport} pairs (e.g. a namespace property
  // accessed at more than one call site) into a stable, order-preserving
  // list.
  const bindingsByKey = new Map<string, PluginBinding>()

  function recordBinding(moduleSpecifier: string, namedImport: string): void {
    bindingsByKey.set(`${moduleSpecifier} ${namedImport}`, { module: moduleSpecifier, namedImport })
  }

  function fail(node: ts.Node, reason: string): never {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    throw new Error(
      `tauri.capabilities.test.ts: static analysis of ${fileName}:${line + 1}:${character + 1} hit code it ` +
        `cannot reliably verify against the capability allowlist, so it is refusing to guess: ${reason}`,
    )
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (
        ts.isStringLiteral(statement.moduleSpecifier) &&
        isPluginModuleSpecifier(statement.moduleSpecifier.text)
      ) {
        fail(
          statement,
          `re-exports from plugin module '${statement.moduleSpecifier.text}'; this test only understands ` +
            `direct imports inside files under platform/, not re-exports. Import the specific command(s) ` +
            `directly instead.`,
        )
      }
      continue
    }

    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      fail(
        statement,
        'the imported module specifier is not a plain string literal, so the imported module cannot be ' +
          'statically determined. Use a literal module string in the import.',
      )
    }

    const moduleSpecifier = statement.moduleSpecifier.text
    if (!isPluginModuleSpecifier(moduleSpecifier)) continue

    const importClause = statement.importClause
    if (!importClause) continue // side-effect-only import; no bindings reach an export.

    if (importClause.name) {
      fail(
        importClause,
        `default-imports a Tauri plugin (\`import x from '${moduleSpecifier}'\`); this test cannot ` +
          `statically tell which command(s) calls through the default export reach. Use a named import ` +
          `(\`import { commandFn } from '${moduleSpecifier}'\`) instead.`,
      )
    }

    const namedBindings = importClause.namedBindings
    if (!namedBindings) continue

    if (ts.isNamespaceImport(namedBindings)) {
      namespaceImports.set(namedBindings.name.text, moduleSpecifier)
      continue
    }

    // NamedImports: `import { a, b as c } from '...'`.
    for (const element of namedBindings.elements) {
      const exportedName = (element.propertyName ?? element.name).text
      recordBinding(moduleSpecifier, exportedName)
    }
  }

  function visit(node: ts.Node): void {
    // Dynamic import: `import('@tauri-apps/plugin-x')` or `import(expr)`.
    if (node.kind === ts.SyntaxKind.ImportKeyword && ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const arg = node.parent.arguments[0] as ts.Expression | undefined
      if (!arg || !ts.isStringLiteral(arg)) {
        fail(
          node.parent,
          'calls dynamic `import()` with a module specifier that is not a plain string literal, so this ' +
            'test cannot tell which module (let alone which command) it loads. Use a static top-level ' +
            "import instead.",
        )
      }
      if (isPluginModuleSpecifier(arg.text)) {
        fail(
          node.parent,
          `dynamically imports plugin module '${arg.text}'; whatever property access happens on the ` +
            `resolved module afterwards is not visible to this AST walk. Use a static top-level ` +
            `\`import { ... } from '${arg.text}'\` (or \`import * as ns from '${arg.text}'\` with direct, ` +
            `non-computed property access) instead.`,
        )
      }
    }

    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && namespaceImports.has(node.expression.text)) {
      fail(
        node,
        `accesses "${node.expression.text}" (a namespace import of ` +
          `'${namespaceImports.get(node.expression.text)}') via computed member access (\`${node.expression.text}[...]\`), ` +
          `so the command name it reaches cannot be statically determined -- this is exactly the "build the ` +
          `command name from a variable" pattern this test cannot verify. Use a direct, non-computed property ` +
          `access (\`${node.expression.text}.commandName\`) instead.`,
      )
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaceImports.has(node.expression.text)
    ) {
      recordBinding(namespaceImports.get(node.expression.text)!, node.name.text)
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return [...bindingsByKey.values()]
}

describe('platform/*.ts plugin usage <-> capabilities/default.json permissions', () => {
  // Aggregated across every source file under `platform/` (see
  // `platformSourceFiles` above), not just `tauri.ts` -- deduped by
  // (module, namedImport) so a binding reached from more than one file
  // only appears once.
  const bindingsByKey = new Map<string, PluginBinding>()
  for (const fileName of platformSourceFiles) {
    const filePath = fileURLToPath(new URL(fileName, platformDirUrl))
    const source = readFileSync(filePath, 'utf-8')
    for (const binding of analyzeTauriPluginUsage(source, filePath)) {
      bindingsByKey.set(`${binding.module} ${binding.namedImport}`, binding)
    }
  }
  const actualBindings = [...bindingsByKey.values()]

  it('scanned at least one file under platform/ (sanity check that the directory listing still works)', () => {
    expect(platformSourceFiles.length).toBeGreaterThan(0)
  })

  it('found at least one @tauri-apps/plugin-* import (sanity check that the AST walk still matches real source)', () => {
    expect(actualBindings.length).toBeGreaterThan(0)
  })

  it.each(actualBindings)(
    'the $module import "$namedImport" used under platform/ is covered by the manifest above',
    ({ module, namedImport }) => {
      const manifestEntry = PLUGIN_IMPORT_PERMISSIONS.find(
        (entry) => entry.module === module && entry.namedImport === namedImport,
      )
      expect(
        manifestEntry,
        `a file under platform/ reaches "${namedImport}" from '${module}', but PLUGIN_IMPORT_PERMISSIONS in ` +
          `this test has no entry for it. Either this import is unused (dead code -- remove it), or a new ` +
          `plugin capability was wired into platform/ without adding it here AND to ` +
          `src-tauri/capabilities/default.json -- add both.`,
      ).toBeDefined()
    },
  )

  it.each(PLUGIN_IMPORT_PERMISSIONS)(
    'permission "$permission" (needed by $module\'s "$namedImport") is granted in capabilities/default.json',
    ({ module, namedImport, permission }) => {
      const isActuallyImported = actualBindings.some((b) => b.module === module && b.namedImport === namedImport)
      // Only enforce the grant while some file under platform/ still
      // actually uses this import -- a manifest entry for a call that
      // was removed from platform/ should be deleted from the manifest
      // above, not force a capability grant nothing needs any more.
      if (!isActuallyImported) return
      // A non-command binding (see `permission: null` above) has no
      // permission to look for.
      if (permission === null) return

      expect(
        grantedPermissionIdentifiers,
        `capabilities/default.json is missing "${permission}", which ${module}'s "${namedImport}" (used under ` +
          `platform/) needs -- without it, that call is silently rejected by Tauri's IPC allowlist on a real ` +
          `machine.`,
      ).toContain(permission)
    },
  )

  // Granting a command without the scope it needs is a *silent* runtime
  // failure, not a build error -- the IPC call is allowed through and the
  // fs plugin then rejects the path. That is one layer deeper than the
  // assertions above can see, so it gets its own check.
  it.each(SCOPE_REQUIRED_PERMISSIONS)(
    'permission "$permission" carries its required scope entry "$allow"',
    ({ permission, allow, why }) => {
      const entry = capabilities.permissions.find(
        (candidate) => typeof candidate === 'object' && candidate.identifier === permission,
      )
      expect(
        entry,
        `capabilities/default.json grants "${permission}" without a scope (it is a bare string, or absent). ` +
          `It needs one: ${why}. Replace the plain string with ` +
          `{"identifier": "${permission}", "allow": ["${allow}"]}.`,
      ).toBeDefined()
      if (typeof entry !== 'object') return

      expect(
        entry.allow,
        `capabilities/default.json's "${permission}" entry has a scope, but its "allow" list does not contain ` +
          `"${allow}". ${why}.`,
      ).toContain(allow)
    },
  )

  // The reverse direction: every permission `capabilities/default.json`
  // grants must correspond to an import some file under `platform/`
  // still actually uses. Before this test existed, the delivery-status
  // note's description of the sibling test above claimed this direction
  // was already covered ("反之亦然（孤儿权限也会报错）") -- it was not:
  // adding unused permissions (`fs:allow-write-file`, `shell:allow-execute`,
  // `fs:allow-remove`) to capabilities/default.json passed 19/19 green,
  // because the tests above only ever walk from code to capabilities,
  // never the other way. An orphan grant is not a harmless leftover --
  // it is unreviewed attack surface sitting in a default-deny allowlist
  // for no reason (`shell:allow-execute` sitting unused in this file
  // would be exactly that). This test makes the claim true instead of
  // deleting it.
  it.each(grantedPermissionIdentifiers)(
    'permission "%s" granted in capabilities/default.json is not an orphan',
    (permission) => {
      const manifestEntry = PLUGIN_IMPORT_PERMISSIONS.find((entry) => entry.permission === permission)
      expect(
        manifestEntry,
        `capabilities/default.json grants "${permission}", but PLUGIN_IMPORT_PERMISSIONS in this test has no ` +
          `entry mapping to it. Either this permission is unused and should be removed from ` +
          `capabilities/default.json (extra permissions are extra attack surface, not a harmless margin), or ` +
          `a plugin call that needs it exists somewhere under platform/ and this manifest is missing the ` +
          `corresponding entry -- add it.`,
      ).toBeDefined()
      if (!manifestEntry) return

      const isActuallyImported = actualBindings.some(
        (b) => b.module === manifestEntry.module && b.namedImport === manifestEntry.namedImport,
      )
      expect(
        isActuallyImported,
        `capabilities/default.json grants "${permission}" (mapped to ${manifestEntry.module}'s ` +
          `"${manifestEntry.namedImport}"), but no file under platform/ actually imports/calls it any more -- ` +
          `this is an orphan permission with no code using it. Remove the permission from ` +
          `capabilities/default.json (or, if the code using it is coming back, keep both in sync).`,
      ).toBe(true)
    },
  )
})
