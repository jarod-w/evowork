import { afterEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createRuntimeProbe } from '../src/probe.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('后台批量探测只起一个异步进程，同步查询在完成前后都不阻塞', async () => {
  // Node 本身保证此路径存在；execFile 被替换，不会真的把它当作 Python 执行。
  const probe = createRuntimeProbe({
    interpreter: process.execPath,
    cachedModules: ['docx', 'pptx'],
  });
  expect(probe.hasModule('docx')).toBe(false);
  const pending = probe.refresh(['docx', 'pptx']);
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(probe.hasModule('docx')).toBe(false);
  const callback = vi.mocked(execFile).mock.calls[0]!.at(-1) as (
    error: Error | null,
    stdout: string,
  ) => void;
  callback(null, JSON.stringify({ docx: true, pptx: false }));
  await pending;
  expect(probe.hasModule('docx')).toBe(true);
  expect(probe.hasModule('pptx')).toBe(false);
  expect(execFileSync).not.toHaveBeenCalled();
  probe.invalidate();
  expect(probe.hasModule('docx')).toBe(false);
  expect(execFileSync).not.toHaveBeenCalled();
});

it('探测进程失败或输出损坏时不将组件标为可用', async () => {
  const probe = createRuntimeProbe({ interpreter: process.execPath, cachedModules: ['docx'] });
  probe.setModules(['docx'], true);
  const pending = probe.refresh(['docx']);
  const callback = vi.mocked(execFile).mock.calls[0]!.at(-1) as (
    error: Error | null,
    stdout: string,
  ) => void;
  callback(null, 'not JSON');
  await pending;
  expect(probe.hasModule('docx')).toBe(false);
});
