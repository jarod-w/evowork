import { createHash } from 'node:crypto';

/** Called only from successful native PostToolUse. Contains no memory plaintext. */
export function memoryNoteReceipt(
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  if (
    tool !== 'memoriesadd_ad_hoc_note' ||
    typeof input.filename !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-workbuddy-[a-f0-9]{32}\.md$/u.test(input.filename) ||
    typeof input.note !== 'string'
  )
    return undefined;
  // Only ignore final LF characters outside the snapshot; source text and scope remain exact.
  const note = /\n--- END WORKBUDDY SNAPSHOT [a-f0-9]{64} ---\n*$/u.test(input.note)
    ? input.note.replace(/\n+$/u, '')
    : input.note;
  return `EW_MEMORY_NOTE_V1:${input.filename}:${createHash('sha256').update(note).digest('hex')}`;
}
