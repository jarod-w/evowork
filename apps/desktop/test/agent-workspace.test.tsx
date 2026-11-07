import { useState } from 'react';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkspacePage } from '../src/renderer/views/agent-workspace.js';
import {
  newSingleAgent,
  type AgentWorkspaceItem,
} from '../src/renderer/views/agent-workspace-state.js';
import type { AgentWorkspaceActions } from '../src/shared/ipc.js';

function fixture() {
  let saved: AgentWorkspaceItem[] = [];
  const actions: Partial<AgentWorkspaceActions> = {
    listAgentWorkspace: vi.fn(async () => saved),
    saveAgentWorkspace: vi.fn(async ({ agent }) => {
      const result = { ...agent, revision: 1 };
      saved = [result];
      return result;
    }),
    deleteAgentWorkspace: vi.fn(async () => {
      saved = [];
    }),
  };
  const conversation = vi.fn(async () => {});
  function Workspace() {
    const [items, setItems] = useState<readonly AgentWorkspaceItem[]>([]);
    return (
      <AgentWorkspacePage
        items={items}
        onItemsChange={setItems}
        actions={actions}
        onConversation={conversation}
      />
    );
  }
  return { Workspace, actions, conversation };
}
async function fillSingle(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '新建智能体' }));
  fireEvent.change(await screen.findByLabelText(/智能体名称/), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/角色说明/), { target: { value: '核对材料' } });
  fireEvent.change(screen.getByLabelText(/^工作指令/), { target: { value: '引用依据' } });
}
describe('智能体真实后台界面', () => {
  it('等待后台保存成功后才关闭编辑器，开始对话提交真实配置 id 和需求', async () => {
    const { Workspace, actions, conversation } = fixture();
    render(<Workspace />);
    await fillSingle('周报助手');
    fireEvent.click(screen.getByRole('checkbox', { name: /文档处理/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存智能体' }));
    const card = await screen.findByRole('article', { name: '周报助手' });
    expect(actions.saveAgentWorkspace).toHaveBeenCalledWith({
      agent: expect.objectContaining({ skills: ['documents'] }),
    });
    expect(screen.getByRole('status').textContent).toContain('已保存到本机');
    fireEvent.click(within(card).getByRole('button', { name: '开始对话' }));
    const dialog = screen.getByRole('dialog', { name: '与周报助手对话' });
    fireEvent.change(within(dialog).getByLabelText('任务需求'), { target: { value: '整理周报' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '开始任务' }));
    await waitFor(() => expect(conversation).toHaveBeenCalledWith(expect.any(String), '整理周报'));
  });
  it('后台拒绝保存时保留编辑内容，不显示虚假成功', async () => {
    const { Workspace, actions } = fixture();
    actions.saveAgentWorkspace = vi.fn(async () => {
      throw new Error('配置已改变，请重新打开');
    });
    render(<Workspace />);
    await fillSingle('保留草稿');
    fireEvent.click(screen.getByRole('button', { name: '保存智能体' }));
    expect((await screen.findByRole('status')).textContent).toContain('配置已改变');
    expect((screen.getByLabelText(/智能体名称/) as HTMLInputElement).value).toBe('保留草稿');
    expect(screen.queryByRole('article', { name: '保留草稿' })).toBeNull();
  });
  it('删除需确认且后台成功才移除配置，未接入连接器不可选', async () => {
    const { Workspace, actions } = fixture();
    actions.listAgentWorkspace = vi.fn(async () => [
      { ...newSingleAgent(), id: 'saved', revision: 1, name: '现有助手' },
    ]);
    render(<Workspace />);
    await screen.findByRole('article', { name: '现有助手' });
    fireEvent.click(screen.getByRole('button', { name: '管理现有助手' }));
    fireEvent.click(screen.getByRole('button', { name: '删除配置' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(actions.deleteAgentWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '管理现有助手' }));
    fireEvent.click(screen.getByRole('button', { name: '删除配置' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: '现有助手' })).toBeNull());
    await fillSingle('新助手');
    expect(screen.queryByRole('checkbox', { name: /飞书|企业微信/ })).toBeNull();
  });
  it('未保存配置离开时可以继续编辑或明确放弃', async () => {
    const { Workspace } = fixture();
    render(<Workspace />);
    await fillSingle('未保存');
    fireEvent.click(screen.getByRole('button', { name: '返回智能体' }));
    const dialog = await screen.findByRole('dialog', { name: '离开当前配置？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }));
    expect((screen.getByLabelText(/智能体名称/) as HTMLInputElement).value).toBe('未保存');
  });
});
