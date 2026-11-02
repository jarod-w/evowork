import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

const locks = new Map();
const waitFor = (ready) => {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error('Disposable memory lock did not change state');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
function cleanupLock(lease) {
  if (dirname(resolve(lease.dir)) !== resolve(tmpdir())) throw new Error('Invalid fixture lease');
  rmSync(lease.dir, { recursive: true, force: true });
}
function windowsMemoryLock(target, locked) {
  if (!locked) {
    const lease = locks.get(target);
    if (!lease) throw new Error('Memory fixture is not locked');
    writeFileSync(lease.release, 'release');
    try {
      waitFor(() => !existsSync(lease.ready));
    } finally {
      lease.child.kill();
      locks.delete(target);
      cleanupLock(lease);
    }
    return;
  }
  if (locks.has(target)) throw new Error('Memory fixture already locked');
  const dir = mkdtempSync(join(tmpdir(), 'evowork-memory-lock-'));
  const lease = {
    dir,
    ready: join(dir, 'ready'),
    release: join(dir, 'release'),
    error: join(dir, 'error'),
  };
  const script = [
    '$ErrorActionPreference="Stop"',
    '$handle=$null',
    'try {',
    '$handle=[IO.File]::Open($env:EVOWORK_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)',
    '[IO.File]::WriteAllText($env:EVOWORK_LOCK_READY,"ready")',
    '$until=[DateTime]::UtcNow.AddSeconds(60)',
    'while (![IO.File]::Exists($env:EVOWORK_LOCK_RELEASE) -and [DateTime]::UtcNow -lt $until) { [Threading.Thread]::Sleep(20) }',
    '} catch { [IO.File]::WriteAllText($env:EVOWORK_LOCK_ERROR,$_.Exception.GetType().Name) }',
    'finally { if ($handle) { $handle.Dispose() }; [IO.File]::Delete($env:EVOWORK_LOCK_READY) }',
  ].join('\n');
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  lease.child = spawn(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        EVOWORK_LOCK_TARGET: target,
        EVOWORK_LOCK_READY: lease.ready,
        EVOWORK_LOCK_RELEASE: lease.release,
        EVOWORK_LOCK_ERROR: lease.error,
      },
    },
  );
  lease.child.on('error', () => {});
  try {
    waitFor(() => existsSync(lease.ready) || existsSync(lease.error));
    if (existsSync(lease.error))
      throw new Error('Memory fixture lock failed: ' + readFileSync(lease.error, 'utf8'));
    locks.set(target, lease);
  } catch (error) {
    lease.child.kill();
    cleanupLock(lease);
    throw error;
  }
}

/** Force a genuine per-project filesystem failure inside the disposable native workspace. */
export function lockImportedMemory(kernelHome, key, locked) {
  const root = join(
    kernelHome,
    'memories',
    'extensions',
    'external_agent_import',
    'resources',
    key,
  );
  // An actual sharing violation blocks native copy and replacement, while permitting reads.
  if (process.platform === 'win32') {
    windowsMemoryLock(join(root, 'MEMORY.md'), locked);
    return;
  }
  chmodSync(root, locked ? 0o555 : 0o755);
}

/** A scripted model uses real native exec to read imported evidence and write derived artifacts. */
const consolidationScript = `
from pathlib import Path
import json
root = Path.cwd()
parts = []
for scope in sorted(root.glob('extensions/external_agent_import/resources/*/scope.json')):
    cwd = json.loads(scope.read_text(encoding='utf-8'))['cwd']
    source = scope.parent / 'MEMORY.md'
    if source.exists():
        parts.append('## Project ' + cwd + '\\n' + source.read_text(encoding='utf-8'))
(root / 'MEMORY.md').write_text('# Imported project memory\\n' + '\\n'.join(parts), encoding='utf-8')
(root / 'memory_summary.md').write_text('v1\\n## What is in memory\\nImported project reference: consult MEMORY.md for project-scoped evidence.\\n', encoding='utf-8')
print('IMPORTED_EVIDENCE_READ\\n' + '\\n'.join(parts))
`;

const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
export const consolidationCommand =
  process.platform === 'win32'
    ? '& ' +
      [
        process.env.EVOWORK_OFFICE_PYTHON ?? 'python',
        '-c',
        'import base64,sys;exec(base64.b64decode(sys.argv[1]))',
        Buffer.from(consolidationScript).toString('base64'),
      ]
        .map(psQuote)
        .join(' ')
    : `python3 - <<'PY'\n${consolidationScript}\nPY`;
