import { describe, expect, it, vi } from 'vitest';
import { createBrowserSession, validate } from '../../plugins/connectors/browser/runtime.mjs';
import { assessComputerUseAction } from '../../services/policy/src/computer-use-action.ts';

function setup() {
  let page = {
    url: 'https://example.test/form',
    title: '表单',
    text: '待发送正文',
    elements: [{ element_index: 1, role: 'button', label: '发送', enabled: true, editable: false }],
  };
  const ask = vi.fn(async () => true);
  const driver = {
    setOriginGuard: vi.fn(),
    snapshot: vi.fn(async () => structuredClone(page)),
    navigate: vi.fn(),
    action: vi.fn(),
    screenshot: vi.fn(async () => 'png'),
    download: vi.fn(async () => ({ path: '/downloads/report.csv', bytes: 4 })),
    close: vi.fn(),
  };
  const session = createBrowserSession({ driver, ask, assessAction: assessComputerUseAction });
  const read = async () => JSON.parse((await session.call('browser_snapshot', {})).content[0].text);
  return {
    session,
    ask,
    driver,
    read,
    change: (patch) => {
      page = { ...page, ...patch };
    },
  };
}
describe('browser 的准入、动作审批与闭环', () => {
  it('新 origin 先准入；发送独立确认并消费状态，随后必须重读', async () => {
    const s = setup();
    const state = await s.read();
    expect(s.ask).toHaveBeenCalledTimes(1);
    await s.session.call('browser_click', { state_id: state.state_id, element_index: 1 });
    expect(s.ask.mock.calls[1][0]).toContain('发送或提交内容');
    expect(s.ask.mock.calls[1][0]).toContain('待发送正文');
    expect(s.driver.action).toHaveBeenCalledTimes(1);
    await expect(
      s.session.call('browser_click', { state_id: state.state_id, element_index: 1 }),
    ).rejects.toThrow('STALE_STATE');
  });
  it('拒绝动作后不能重试、改工具或导航绕过', async () => {
    const s = setup();
    const state = await s.read();
    s.ask.mockResolvedValueOnce(false);
    await expect(
      s.session.call('browser_click', { state_id: state.state_id, element_index: 1 }),
    ).rejects.toThrow('APP_DENIED');
    await expect(s.session.call('browser_navigate', { url: 'https://other.test' })).rejects.toThrow(
      'USER_STOPPED',
    );
    expect(s.driver.action).not.toHaveBeenCalled();
  });
  it('审批中目标变化不能执行；文件与密码输入在审批前拒绝', async () => {
    const s = setup();
    const state = await s.read();
    s.ask.mockImplementationOnce(async () => {
      s.change({ text: '目标已改变' });
      return true;
    });
    await expect(
      s.session.call('browser_click', { state_id: state.state_id, element_index: 1 }),
    ).rejects.toThrow('STALE_STATE');
    expect(s.driver.action).not.toHaveBeenCalled();
    for (const type of ['file', 'password', 'FILE', 'PASSWORD']) {
      s.change({
        elements: [{ element_index: 1, role: 'input', type, enabled: true, editable: true }],
      });
      const next = await s.read();
      await expect(
        s.session.call('browser_fill', {
          state_id: next.state_id,
          element_index: 1,
          text: '/private/file',
        }),
      ).rejects.toThrow('POLICY_DENIED');
    }
  });
  it('拒绝 origin 会保存拒绝，不能再次请求；显式下载仍单次确认', async () => {
    const s = setup();
    s.ask.mockResolvedValueOnce(false);
    await expect(
      s.session.call('browser_navigate', { url: 'https://blocked.test/' }),
    ).rejects.toThrow('APP_DENIED');
    await expect(
      s.session.call('browser_navigate', { url: 'https://blocked.test/again' }),
    ).rejects.toThrow('POLICY_DENIED');
    expect(s.ask).toHaveBeenCalledTimes(1);
    expect(s.driver.navigate).not.toHaveBeenCalled();
    s.ask.mockResolvedValue(true);
    await s.session.call('browser_download', {
      url: 'https://example.test/report',
      filename: 'report.csv',
    });
    expect(s.ask.mock.calls.at(-1)[0]).toContain('下载文件');
    expect(s.driver.download).toHaveBeenCalledTimes(1);
  });
  it('截图返回原生图片内容；下载不接受路径，工具面不接受任意代码或许可', async () => {
    const s = setup();
    expect((await s.session.call('browser_screenshot', {})).content[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'png',
    });
    await expect(
      s.session.call('browser_download', {
        url: 'https://example.test/report',
        filename: '../report',
      }),
    ).rejects.toThrow('POLICY_DENIED');
    expect(() =>
      validate('browser_click', { state_id: 's', element_index: 1, approved: true }),
    ).toThrow('POLICY_DENIED');
    expect(() => validate('eval', { code: 'alert(1)' })).toThrow('POLICY_DENIED');
  });
});
