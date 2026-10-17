import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** White-box assertions only inside disposable E2E native homes. */
export function workbuddyNotes(kernelHome) {
  const root = join(kernelHome, 'memories/extensions/ad_hoc/notes');
  return existsSync(root)
    ? readdirSync(root)
        .filter((n) => n.includes('-workbuddy-'))
        .map((filename) => ({ filename, text: readFileSync(join(root, filename), 'utf8') }))
    : [];
}

/** Scripted consolidation model reads actual native notes; no preseeded summary. */
export const workbuddyConsolidationCommand = `python3 - <<'PY'
from pathlib import Path
root = Path.cwd()
text = '\\n'.join(p.read_text() for p in sorted(root.glob('extensions/ad_hoc/notes/*-workbuddy-*.md')))
(root / 'MEMORY.md').write_text('# WorkBuddy imported memory\\n' + text)
(root / 'memory_summary.md').write_text('v1\\nWorkBuddy preference [ad-hoc note]: use violet reports; consult MEMORY.md for scope and evidence.\\n')
print('WORKBUDDY_EVIDENCE_READ\\n' + text)
PY`;
