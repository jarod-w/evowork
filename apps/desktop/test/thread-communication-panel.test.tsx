import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreadCommunicationPanel } from '../src/renderer/components/thread-communication-panel.js';
function setup() {
  const actions = {
    getCommunicationTargets: vi.fn(async () => [
      { id: 'b', title: '季度核对', projectId: 'p', status: 'idle' },
    ]),
    getCommunicationRecords: vi.fn(async () => []),
    sendCommunication: vi.fn(async () => ({ requestId: 'r' })),
    cancelCommunication: vi.fn(),
    checkCommunication: vi.fn(),
  };
  const result = render(<ThreadCommunicationPanel threadId="a" actions={actions} />);
  const details = result.container.querySelector('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  return actions;
}
describe('会话通信入口', () => {
  it('选择目标并展示正文后显式发送，默认不列跨项目会话', async () => {
    const actions = setup();
    await screen.findByRole('option', { name: /季度核对/ });
    expect(actions.getCommunicationTargets).toHaveBeenCalledWith({
      threadId: 'a',
      includeOtherProjects: false,
    });
    fireEvent.change(screen.getByLabelText('通信目标会话'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('会话请求内容'), { target: { value: '请检查季度表' } });
    fireEvent.click(screen.getByRole('button', { name: '发送会话请求' }));
    await waitFor(() =>
      expect(actions.sendCommunication).toHaveBeenCalledWith({
        sourceThreadId: 'a',
        targetThreadId: 'b',
        text: '请检查季度表',
        clientId: expect.any(String),
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('会话请求内容') as HTMLTextAreaElement).value).toBe(''),
    );
  });
  it('只有用户勾选后才允许选择跨项目，切换范围清空旧目标', async () => {
    const actions = setup();
    await screen.findByRole('option', { name: /季度核对/ });
    fireEvent.change(screen.getByLabelText('通信目标会话'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(actions.getCommunicationTargets).toHaveBeenLastCalledWith({
        threadId: 'a',
        includeOtherProjects: true,
      }),
    );
    expect((screen.getByLabelText('通信目标会话') as HTMLSelectElement).value).toBe('');
    expect(actions.sendCommunication).not.toHaveBeenCalled();
  });
});
