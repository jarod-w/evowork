import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** White-box assertions only inside disposable E2E native homes. */
export function workbuddyNotes(kernelHome) {
  const root = join(kernelHome, 'memories/extensions/ad_hoc/notes');
  return existsSync(root)
    ? readdirSync(root)
        .filter((n) => n.includes('-workbuddy-'))
        .map((filename) => ({ filename, text: readFileSync(join(root, filename), 'utf8') }))
    : [];
}

/** Scripted consolidation reads the actual native diff; no bypass through notes or preseeded summary. */
export const workbuddyConsolidationCommand = `python3 - <<'PY'
from pathlib import Path
root = Path.cwd()
text = (root / 'phase2_workspace_diff.md').read_text()
assert '- A extensions/ad_hoc/notes/' in text, 'Initial baseline hid imported notes'
assert 'WORKBUDDY_NATIVE_EVIDENCE' in text, 'Native diff omitted imported fact'
(root / 'MEMORY.md').write_text('# WorkBuddy imported memory\\n' + text)
(root / 'memory_summary.md').write_text('v1\\nWorkBuddy preference [ad-hoc note]: use violet reports; consult MEMORY.md for scope and evidence.\\n')
print('WORKBUDDY_EVIDENCE_READ\\n' + text)
PY`;

/** Read-only diagnostics for disposable fixtures. Never persists native log bodies or credentials. */
export function workbuddyRuntimeEvidence(kernelHome) {
  const config = readFileSync(join(kernelHome, 'config.toml'), 'utf8');
  const streamMaxRetries = Number(config.match(/^stream_max_retries\s*=\s*(\d+)/m)?.[1]);
  const path = join(kernelHome, 'logs_2.sqlite');
  if (!existsSync(path)) return { streamMaxRetries, upstream503Errors: 0, unsupportedPlanCalls: 0 };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const logs = db
      .prepare(
        'SELECT feedback_log_body FROM logs WHERE feedback_log_body LIKE ? OR feedback_log_body LIKE ?',
      )
      .all('%Turn error:%', '%unsupported call: update_plan%')
      .map((row) => row.feedback_log_body ?? '');
    return {
      streamMaxRetries,
      upstream503Errors: logs.filter(
        (body) =>
          body.includes('Turn error:') &&
          body.includes('ServiceUnavailableError') &&
          body.includes('503'),
      ).length,
      unsupportedPlanCalls: logs.filter((body) => body.includes('unsupported call: update_plan'))
        .length,
    };
  } finally {
    db.close();
  }
}
