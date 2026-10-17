import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryPreparation,
  memoryPreparationLabel,
} from '../src/renderer/components/memory-preparation.js';
import { MemoryImportOverview } from '../src/renderer/components/memory-import.js';
import type { MemorySettingsView } from '../src/shared/ipc.js';

const memory: MemorySettingsView = {
  enabled: true,
  version: 'v2',
  useMemories: true,
  generateMemories: false,
  disableOnExternalContext: true,
  statusSupported: true,
  resetSupported: true,
  taskModeSupported: true,
  ready: false,
  consolidatedThreads: 0,
};

describe('整理状态真实语义', () => {
  it('未就绪不声称后台作业正在运行；V1 无进度，整体就绪不说明导入批次完成', () => {
    expect(memoryPreparationLabel(memory)).toContain('尚未达到');
    expect(memoryPreparationLabel({ ...memory, version: 'v1' })).toContain('不提供整理进度');
    expect(memoryPreparationLabel({ ...memory, ready: true, consolidatedThreads: 22 })).toContain(
      '已整理 22 个任务',
    );
    expect(memoryPreparationLabel({ ...memory, statusSupported: false })).toContain(
      '不提供记忆准备进度',
    );
  });
  it('读取失败明确显示并可重试；更晚的关闭组件不会接收旧结果', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(memory);
    const view = render(<MemoryPreparation read={read} />);
    await screen.findByText('无法读取整理状态，请重试。');
    fireEvent.click(screen.getByRole('button', { name: '刷新整理状态' }));
    await screen.findByText(/尚未达到记忆就绪条件/);
    expect(screen.getByText(/不能确认某次导入/)).toBeTruthy();
    view.unmount();
  });
});

describe('同步开关保存与撤销', () => {
  it('立即响应点击，保存失败回滚并显示错误；来源功能关闭后仍可关闭同步', async () => {
    let reject!: (error: Error) => void;
    const set = vi.fn(
      () =>
        new Promise<never>((_resolve, no) => {
          reject = no;
        }),
    );
    const ports = {
      getMemoryImportStatus: async () => ({
        supported: true,
        sync: { enabled: false, projectKeys: ['alpha'] },
        history: [{ id: '1', completedAt: 1, projects: [{ key: 'alpha', ok: true }] }],
      }),
      setMemoryImportSync: set,
    };
    const view = render(<MemoryImportOverview ports={ports} onStart={() => undefined} />);
    const toggle = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    reject(new Error('设置未保存'));
    await screen.findByText('设置未保存');
    expect(toggle.checked).toBe(false);
    view.unmount();
    render(
      <MemoryImportOverview
        ports={{
          ...ports,
          getMemoryImportStatus: async () => ({
            supported: false,
            sync: { enabled: true, projectKeys: ['alpha'] },
            history: [],
          }),
        }}
        onStart={() => undefined}
      />,
    );
    expect(((await screen.findByRole('checkbox')) as HTMLInputElement).disabled).toBe(false);
  });
});
