import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
//   1. Which `@tauri-apps/plugin-*` named imports `tauri.ts` actually
//      uses (parsed out of its source with a regex -- this file
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

const tauriTsSource = readFileSync(fileURLToPath(tauriTsUrl), 'utf-8')
const capabilities = JSON.parse(readFileSync(fileURLToPath(capabilitiesUrl), 'utf-8')) as {
  permissions: string[]
}

interface PluginBinding {
  module: string
  namedImport: string
}

// Manifest: every named import `tauri.ts` pulls from a
// `@tauri-apps/plugin-*` package, and the exact capability permission
// identifier that import needs so it isn't rejected by the IPC allowlist
// at runtime. Keep this in lockstep with both `tauri.ts`'s import list
// and `capabilities/default.json`'s permission list -- the tests below
// fail if either one drifts from this manifest.
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

// Parses `import { a, b as c } from '@tauri-apps/plugin-...'` statements
// out of `tauri.ts`'s source, returning every (module, exported name)
// pair -- e.g. `{ enable as enableAutoLaunch }` yields `{ module:
// '...autostart', namedImport: 'enable' }`, since the permission system
// cares about the plugin's exported/command name, not the local alias
// `tauri.ts` chose for it.
function importedPluginBindings(source: string): PluginBinding[] {
  const bindings: PluginBinding[] = []
  const importStatementPattern = /import\s*\{([^}]+)\}\s*from\s*'(@tauri-apps\/plugin-[^']+)'/g
  for (const match of source.matchAll(importStatementPattern)) {
    const [, namedImportsBlock, module] = match
    for (const rawSpecifier of namedImportsBlock.split(',')) {
      const specifier = rawSpecifier.trim()
      if (!specifier) continue
      const exportedName = specifier.split(/\s+as\s+/)[0].trim()
      bindings.push({ module, namedImport: exportedName })
    }
  }
  return bindings
}

describe('platform/tauri.ts plugin usage <-> capabilities/default.json permissions', () => {
  const actualBindings = importedPluginBindings(tauriTsSource)

  it('found at least one @tauri-apps/plugin-* import (sanity check that the regex still matches real source)', () => {
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
        `tauri.ts imports { ${namedImport} } from '${module}', but PLUGIN_IMPORT_PERMISSIONS in this test ` +
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
