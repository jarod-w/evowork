import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/** Synthetic external files only; never inspect the user's real agent directories. */
export function seedClaudeMemory(home, cwd, key, text) {
  const root = join(home, '.claude', 'projects', key);
  mkdirSync(join(root, 'memory'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(root, 'memory', 'MEMORY.md'), text);
  writeFileSync(
    join(root, 'session.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd,
      timestamp: new Date().toISOString(),
      message: { content: 'Synthetic memory source' },
    }) + '\n',
  );
  return root;
}

/** Test-only inspection of native generated state, outside all production paths (K2). */
export function importedMemory(kernelHome, key) {
  const root = join(
    kernelHome,
    'memories',
    'extensions',
    'external_agent_import',
    'resources',
    key,
  );
  if (!existsSync(root)) return null;
  return {
    scope: JSON.parse(readFileSync(join(root, 'scope.json'), 'utf8')),
    text: readFileSync(join(root, 'MEMORY.md'), 'utf8'),
  };
}

export function consolidatedMemory(kernelHome) {
  const root = join(kernelHome, 'memories');
  try {
    return {
      summary: readFileSync(join(root, 'memory_summary.md'), 'utf8'),
      memory: readFileSync(join(root, 'MEMORY.md'), 'utf8'),
    };
  } catch {
    return null;
  }
}

/** Inspect only an isolated imported resource, including removal during a manual update. */
export function importedReferenceFile(kernelHome, key, filename) {
  const path = join(
    kernelHome,
    'memories',
    'extensions',
    'external_agent_import',
    'resources',
    key,
    filename,
  );
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Force a genuine per-project filesystem failure inside the disposable native workspace. */
export function lockImportedMemory(kernelHome, key, locked) {
  chmodSync(
    join(kernelHome, 'memories', 'extensions', 'external_agent_import', 'resources', key),
    locked ? 0o555 : 0o755,
  );
}

/** A scripted model uses real native exec to read imported evidence and write derived artifacts. */
export const consolidationCommand = `python3 - <<'PY'
from pathlib import Path
import json
root = Path.cwd()
parts = []
for scope in sorted(root.glob('extensions/external_agent_import/resources/*/scope.json')):
    cwd = json.loads(scope.read_text())['cwd']
    source = scope.parent / 'MEMORY.md'
    if source.exists():
        parts.append('## Project ' + cwd + '\\n' + source.read_text())
(root / 'MEMORY.md').write_text('# Imported project memory\\n' + '\\n'.join(parts))
(root / 'memory_summary.md').write_text('v1\\n## What is in memory\\nImported project reference: consult MEMORY.md for project-scoped evidence.\\n')
print('IMPORTED_EVIDENCE_READ\\n' + '\\n'.join(parts))
PY`;
