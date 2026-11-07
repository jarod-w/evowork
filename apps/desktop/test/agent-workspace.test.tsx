import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentWorkspacePage } from '../src/renderer/views/agent-workspace.js';
import {
  createAgentWorkspaceExamples,
  type AgentWorkspaceItem,
} from '../src/renderer/views/agent-workspace-state.js';

function Workspace({
  initial = createAgentWorkspaceExamples(),
}: {
  initial?: readonly AgentWorkspaceItem[];
}) {
  const [items, setItems] = useState(initial);
  return <AgentWorkspacePage items={items} onItemsChange={setItems} />;
}
async function fillSingle(name: string) {
  await screen.findByLabelText(/智能体名称/);
  fireEvent.change(screen.getByLabelText(/智能体名称/), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/角色说明/), {
    target: { value: '整理材料并生成工作报告。' },
  });
  fireEvent.change(screen.getByLabelText(/^工作指令/), {
    target: { value: '先核对来源，再输出结论。' },
  });
}

afterEach(() => vi.useRealTimers());

describe('智能体工作台前端评审', () => {
  it('创建配置后可搜索、编辑和预览任务，页面明确说明仅暂存会话', async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole('button', { name: '新建智能体' }));
    await fillSingle('周报助手');
    fireEvent.click(screen.getByRole('checkbox', { name: /文档处理/ }));
    expect(screen.getByRole('heading', { name: '周报助手' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存智能体' }));
    expect(screen.getByRole('status').textContent).toContain('本次会话');
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索智能体' }), {
      target: { value: '周报' },
    });
    const card = screen.getByRole('article', { name: '周报助手' });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: '编辑' }));
    expect((screen.getByLabelText(/角色说明/) as HTMLTextAreaElement).value).toContain('整理材料');
    fireEvent.click(screen.getByRole('button', { name: '保存并开始对话' }));
    const dialog = screen.getByRole('dialog', { name: '与周报助手对话' });
    fireEvent.change(within(dialog).getByLabelText('任务需求'), {
      target: { value: '<script>example</script>' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '预览任务' }));
    expect(within(dialog).getByText('<script>example</script>')).toBeTruthy();
    expect(dialog.querySelector('script')).toBeNull();
    expect(within(dialog).getByText(/不创建任务或调用模型/)).toBeTruthy();
  });

  it('未保存配置离开时可继续编辑或明确放弃，删除配置有确认', async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole('button', { name: '新建智能体' }));
    await fillSingle('未保存助手');
    fireEvent.click(screen.getByRole('button', { name: '返回智能体' }));
    const leave = await screen.findByRole('dialog', { name: '离开当前配置？' });
    fireEvent.click(within(leave).getByRole('button', { name: '继续编辑' }));
    expect((screen.getByLabelText(/智能体名称/) as HTMLInputElement).value).toBe('未保存助手');
    fireEvent.click(screen.getByRole('button', { name: '返回智能体' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '放弃并离开' }),
    );
    await screen.findByRole('heading', { name: /我的智能体/ });
    expect(screen.queryByRole('article', { name: '未保存助手' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '管理报告撰写助手' }));
    fireEvent.click(screen.getByRole('button', { name: '删除配置' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('article', { name: '报告撰写助手' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '管理报告撰写助手' }));
    fireEvent.click(screen.getByRole('button', { name: '删除配置' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(screen.queryByRole('article', { name: '报告撰写助手' })).toBeNull();
  });

  it('运行演示读取修改后的节点，在人工确认前不进入下一批，停止后不继续', async () => {
    vi.useFakeTimers();
    render(<Workspace />);
    const card = screen.getByRole('article', { name: '经营分析协作团队' });
    fireEvent.click(within(card).getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('tab', { name: '② 流程编排' }));
    fireEvent.change(screen.getByLabelText(/节点名称/), { target: { value: '核对分析目标' } });
    fireEvent.change(screen.getByLabelText('完成条件'), { target: { value: 'human' } });
    fireEvent.click(screen.getByRole('tab', { name: '③ 运行监控' }));
    fireEvent.click(screen.getByRole('button', { name: '模拟运行' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('流程等待人工确认')).toBeTruthy();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('0 / 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('1 / 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('1 / 5')).toBeTruthy();
    expect(screen.getByRole('log').textContent).toContain('演示已停止');
  });

  it('空列表仍能创建单体与团队，搜索无结果可清除', () => {
    render(<Workspace initial={[]} />);
    expect(screen.getByText('还没有这类智能体')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在' } });
    expect(screen.getByText('没有找到匹配的智能体')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '清除搜索' })[0]!);
    expect(screen.getByText('还没有这类智能体')).toBeTruthy();
  });
});
