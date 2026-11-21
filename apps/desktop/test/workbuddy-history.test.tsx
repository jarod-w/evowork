import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkBuddyHistory } from '../src/renderer/components/workbuddy-memory-import.js';
import type { WorkBuddyImportRecordView } from '../src/shared/ipc.js';

describe('WorkBuddy 导入历史', () => {
  it('显示失败原因、未知原因和旧历史，区分保存与整理', () => {
    const base = { createdAt: 1, scope: 'personal', filename: 'note.md' };
    const records: WorkBuddyImportRecordView[] = [
      { ...base, id: 'saved', state: 'saved' },
      { ...base, id: 'failed', state: 'failed', reason: 'receipt_mismatch' },
      { ...base, id: 'timeout', state: 'unknown', reason: 'timeout' },
      { ...base, id: 'legacy', state: 'unknown' },
      { ...base, id: 'pending', state: 'pending' },
    ];
    render(
      <WorkBuddyHistory status={{ supported: true, models: [], projects: [], history: records }} />,
    );
    expect(screen.getByText(/资料已保存，等待后续整理/)).toBeTruthy();
    expect(screen.getByText(/导入未完成：保存回执的文件名或正文/)).toBeTruthy();
    expect(screen.getByText(/结果未确认：等待保存回执超时/)).toBeTruthy();
    expect(screen.getByText(/结果未确认：未收到可信保存回执/)).toBeTruthy();
    expect(screen.getByText(/正在导入/)).toBeTruthy();
  });
});
