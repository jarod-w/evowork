import { describe, expect, it } from 'vitest';
import { handlePostToolUse, memoryNoteReceipt } from '../src/index.js';

describe('memory note completion receipt', () => {
  const filename = `2026-10-17T12-00-00-workbuddy-${'a'.repeat(32)}.md`;
  it('emits a digest of exact native note arguments without including plaintext', () => {
    const receipt = memoryNoteReceipt('memoriesadd_ad_hoc_note', {
      filename,
      note: 'private preference',
    });
    expect(receipt).toMatch(/^EW_MEMORY_NOTE_V1:.*:[a-f0-9]{64}$/u);
    expect(receipt).not.toContain('private preference');
    const r = handlePostToolUse(
      {
        session_id: 'thread',
        turn_id: 'turn',
        cwd: '/work',
        hook_event_name: 'PostToolUse',
        tool_name: 'memoriesadd_ad_hoc_note',
        tool_use_id: 'call',
        tool_input: { filename, note: 'private preference' },
      },
      { home: '/home/user', now: () => 1, readFile: () => undefined },
    );
    expect(r.output).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: receipt },
    });
    expect(JSON.stringify(r.audit)).not.toContain('private preference');
  });
  it('normalizes only trailing LF outside the snapshot, preserving every source and scope byte', () => {
    const note = `Scope: project:alpha\n--- BEGIN WORKBUDDY SNAPSHOT ${'b'.repeat(64)} ---\n原文\n--- END WORKBUDDY SNAPSHOT ${'b'.repeat(64)} ---`;
    const digest = (value: string) =>
      memoryNoteReceipt('memoriesadd_ad_hoc_note', { filename, note: value });
    expect(digest(note + '\n\n')).toBe(digest(note));
    expect(digest(note.replace('原文', '原文\n'))).not.toBe(digest(note));
    expect(digest(note.replace('alpha', 'beta'))).not.toBe(digest(note));
    expect(digest(note + ' \n')).not.toBe(digest(note));
    expect(digest('plain\n')).not.toBe(digest('plain'));
  });
  it('does not turn ordinary tool outputs or malformed paths into memory receipts', () => {
    expect(memoryNoteReceipt('exec_command', { filename, note: 'x' })).toBeUndefined();
    expect(
      memoryNoteReceipt('memoriesadd_ad_hoc_note', { filename: '../' + filename, note: 'x' }),
    ).toBeUndefined();
  });
});
