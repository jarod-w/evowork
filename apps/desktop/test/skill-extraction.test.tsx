import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EvoworkBridge } from '../src/renderer/app.js';
import type { ComposerContextView } from '../src/shared/ipc.js';
import type { SkillExtractionView, SkillSourceView } from '../src/shared/skill-extraction.js';
import { useSkillExtraction } from '../src/renderer/views/skill-extraction.js';

const source: SkillSourceView = {
  threadId: 'source',
  title: '销售分析',
  capturedAt: 1,
  projectId: null,
  projectName: null,
  turns: [{ id: 'one', label: '第1轮' }],
  evidence: [],
};
const draft: SkillExtractionView = {
  id: 'draft',
  threadId: 'extract',
  source,
  sourceDeleted: false,
  focus: '',
  revision: 1,
  scope: 'global',
  content: {
    slug: 'sales-review',
    name: '销售复盘',
    description: '分析销售数据。',
    instructions: '## 处理方法\n核对统计口径。',
    sources: [],
    files: [],
    changes: [],
  },
  state: 'saved',
  error: null,
  installed: { path: '/skills/sales-review', revision: 1, scope: 'global', slug: 'sales-review' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Harness({
  taskId,
  bridge,
  onUse = vi.fn(),
}: {
  taskId: string;
  bridge: EvoworkBridge;
  onUse?: (value: unknown) => void;
}) {
  const flow = useSkillExtraction({
    bridge,
    taskId,
    modelId: undefined,
    running: false,
    openTask: vi.fn(),
    useSkill: onUse,
    changed: vi.fn(),
    failed: vi.fn(),
  });
  return (
    <>
      {flow.panel}
      {flow.contextBar}
      {flow.dialogs}
      <button onClick={flow.begin}>发起提炼</button>
      <button onClick={() => void flow.refresh()}>刷新草稿</button>
    </>
  );
}
describe('技能提炼异步操作与用户正在查看的任务隔离', () => {
  it('技能候选迟到时不覆盖用户已经切换到的任务或输入', async () => {
    const pending = deferred<ComposerContextView>();
    const bridge = {
      getSkillExtraction: vi.fn(async ({ threadId }: { threadId: string }) =>
        threadId === 'extract' ? draft : null,
      ),
      getComposerContext: vi.fn(() => pending.promise),
    } as unknown as EvoworkBridge;
    const onUse = vi.fn();
    const view = render(<Harness taskId="extract" bridge={bridge} onUse={onUse} />);
    fireEvent.click(await screen.findByRole('button', { name: '用此技能新建任务' }));
    view.rerender(<Harness taskId="other" bridge={bridge} onUse={onUse} />);
    await act(async () => {
      pending.resolve({
        commands: [],
        mentions: [
          {
            id: 'skill',
            category: 'skill',
            insertAs: 'skill',
            label: 'sales-review',
            name: 'sales-review',
            path: '/skills/sales-review/SKILL.md',
            scope: 'user',
          },
        ],
      });
      await pending.promise;
    });
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '技能草稿' })).toBeNull();
  });
  it('来源读取迟到时不在另一个任务弹出旧来源的提炼窗口', async () => {
    const pending = deferred<SkillSourceView>();
    const bridge = {
      startSkillExtraction: vi.fn(),
      getSkillExtraction: vi.fn(async () => null),
      getSkillSource: vi.fn(() => pending.promise),
    } as unknown as EvoworkBridge;
    const view = render(<Harness taskId="source" bridge={bridge} />);
    fireEvent.click(screen.getByRole('button', { name: '发起提炼' }));
    view.rerender(<Harness taskId="other" bridge={bridge} />);
    await act(async () => {
      pending.resolve(source);
      await pending.promise;
    });
    expect(screen.queryByRole('dialog', { name: '从本任务提炼技能' })).toBeNull();
  });
  it('能力确认绑定审阅版本，后台发布新修订后必须重新检查', async () => {
    let current = { ...draft, state: 'draft' as const, installed: null };
    const save = vi.fn(async () => ({
      draft: current,
      needsConfirm: true,
      audit: { skillId: 'sales-review', level: 'p1', findings: ['运行受限命令'] },
    }));
    const bridge = {
      getSkillExtraction: vi.fn(async () => current),
      saveSkillExtraction: save,
    } as unknown as EvoworkBridge;
    render(<Harness taskId="extract" bridge={bridge} />);
    fireEvent.click(await screen.findByRole('button', { name: '保存并启用' }));
    await screen.findByRole('dialog', { name: '安装前请确认' });
    current = { ...current, revision: 2 };
    fireEvent.click(screen.getByRole('button', { name: '刷新草稿' }));
    await waitFor(() => expect(screen.getByText('修订2')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('我已了解'));
    const buttons = screen.getAllByRole('button', { name: '保存并启用' });
    fireEvent.click(buttons.at(-1)!);
    await screen.findByText('草稿版本或范围已变化，请重新检查能力后保存。');
    expect(save).toHaveBeenCalledTimes(1);
  });
});
