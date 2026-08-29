import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

// FORCING FUNCTION -- read before touching either `tauri.ts` or
// `../../src-tauri/capabilities/default.json`.
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
//   1. Which `@tauri-apps/plugin-*` imports `tauri.ts` actually uses, and
//      which of their exports it actually reaches (parsed from a real
//      TypeScript AST via the `typescript` compiler API -- this file
//      deliberately does not import `./tauri` itself, which would
//      require mocking every plugin just to load the module).
//   2. Which permission identifiers `../../src-tauri/capabilities/default.json`
//      actually grants.
// Every plugin import `tauri.ts` makes MUST appear in the manifest below
// (an import missing from it means either the manifest went stale or a
// genuinely new capability was wired up without telling this test --
// both must fail loudly), and the permission the manifest says that
// import needs MUST be present in the capability file. Concretely, this
// fails if either of these happens:
//   - `tauri.ts` gains a new plugin call with no corresponding manifest
//     entry (a new import shows up that `PLUGIN_IMPORT_PERMISSIONS`
//     doesn't know about).
//   - `capabilities/default.json` loses a permission that a
//     still-imported plugin call in `tauri.ts` needs.
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
// would still show 19/19 green, precisely the class of "checks that can
// be silently walked around" this repo has already been bitten by once
// (see the CI-9 grep fix). Parsing a real AST via the `typescript`
// compiler API instead means named imports, namespace imports, and
// dynamic `import()` calls are all visible to the same walk, because
// they're all just node kinds in the same tree, not text patterns that
// have to each be separately guessed at.
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
const tauriTsUrl = new URL('./tauri.ts', thisModuleUrl)
const capabilitiesUrl = new URL('../../src-tauri/capabilities/default.json', thisModuleUrl)

const tauriTsPath = fileURLToPath(tauriTsUrl)
const tauriTsSource = readFileSync(tauriTsPath, 'utf-8')
const capabilities = JSON.parse(readFileSync(fileURLToPath(capabilitiesUrl), 'utf-8')) as {
  permissions: string[]
}

interface PluginBinding {
  module: string
  namedImport: string
}

// Manifest: every export `tauri.ts` pulls from a `@tauri-apps/plugin-*`
// package and reaches (whether via a named import or a namespace-import
// property access), and the exact capability permission identifier that
// export needs so it isn't rejected by the IPC allowlist at runtime. Keep
// this in lockstep with both `tauri.ts`'s plugin usage and
// `capabilities/default.json`'s permission list -- the tests below fail
// if either one drifts from this manifest.
const PLUGIN_IMPORT_PERMISSIONS: ReadonlyArray<PluginBinding & { permission: string }> = [
  { module: '@tauri-apps/plugin-dialog', namedImport: 'open', permission: 'dialog:allow-open' },
  { module: '@tauri-apps/plugin-fs', namedImport: 'readFile', permission: 'fs:allow-read-file' },
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
// (module, exported name) pair it can prove `tauri.ts` reaches inside a
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
//     a plugin module: `tauri.ts` isn't expected to re-export plugin
//     internals, so treat it as unanalyzed rather than assume it's dead.
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
    bindingsByKey.set(`${moduleSpecifier} ${namedImport}`, { module: moduleSpecifier, namedImport })
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
            `direct imports inside tauri.ts, not re-exports. Import the specific command(s) directly instead.`,
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

describe('platform/tauri.ts plugin usage <-> capabilities/default.json permissions', () => {
  const actualBindings = analyzeTauriPluginUsage(tauriTsSource, tauriTsPath)

  it('found at least one @tauri-apps/plugin-* import (sanity check that the AST walk still matches real source)', () => {
    expect(actualBindings.length).toBeGreaterThan(0)
  })

  it.each(actualBindings)(
    'the $module import "$namedImport" used by tauri.ts is covered by the manifest above',
    ({ module, namedImport }) => {
      const manifestEntry = PLUGIN_IMPORT_PERMISSIONS.find(
        (entry) => entry.module === module && entry.namedImport === namedImport,
      )
      expect(
        manifestEntry,
        `tauri.ts reaches "${namedImport}" from '${module}', but PLUGIN_IMPORT_PERMISSIONS in this test ` +
          `has no entry for it. Either this import is unused (dead code -- remove it), or a new plugin ` +
          `capability was wired into tauri.ts without adding it here AND to ` +
          `src-tauri/capabilities/default.json -- add both.`,
      ).toBeDefined()
    },
  )

  it.each(PLUGIN_IMPORT_PERMISSIONS)(
    'permission "$permission" (needed by $module\'s "$namedImport") is granted in capabilities/default.json',
    ({ module, namedImport, permission }) => {
      const isActuallyImported = actualBindings.some((b) => b.module === module && b.namedImport === namedImport)
      // Only enforce the grant while tauri.ts still actually uses this
      // import -- a manifest entry for a call that was removed from
      // tauri.ts should be deleted from the manifest above, not force a
      // capability grant nothing needs any more.
      if (!isActuallyImported) return

      expect(
        capabilities.permissions,
        `capabilities/default.json is missing "${permission}", which ${module}'s "${namedImport}" (used by ` +
          `tauri.ts) needs -- without it, that call is silently rejected by Tauri's IPC allowlist on a real ` +
          `machine.`,
      ).toContain(permission)
    },
  )
})
