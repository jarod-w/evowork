import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ImageSettings, ImageOperationCard } from '../src/renderer/components/image-settings.js';
import type { ImageOperationView, ImageSettingsView } from '../src/shared/ipc.js';
const view: ImageSettingsView = {
  enabled: false,
  hasKey: false,
  secretBackend: 'keychain',
  model: 'flash',
  baseUrl: 'https://example.com/api/v3/',
  models: [{ id: 'flash', name: 'Flash' }],
};
it('默认关闭，独立型号与密钥单向提交，保存后清空输入', async () => {
  const saveImageSettings = vi.fn(async (input) => ({
    ...view,
    enabled: input.enabled,
    hasKey: !!input.apiKey,
  }));
  render(<ImageSettings ports={{ getImageSettings: async () => view, saveImageSettings }} />);
  const toggle = await screen.findByRole('checkbox');
  expect((toggle as HTMLInputElement).checked).toBe(false);
  fireEvent.click(toggle);
  await screen.findByText('已保存。');
  fireEvent.click(screen.getByRole('button', { name: '配置图片模型' }));
  fireEvent.change(screen.getByLabelText('Ark API Key'), { target: { value: 'test-only-key' } });
  fireEvent.click(screen.getByText('保存图片设置'));
  await waitFor(() =>
    expect(saveImageSettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, apiKey: 'test-only-key', model: 'flash' }),
    ),
  );
  await waitFor(() => expect(screen.queryByLabelText('Ark API Key')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '配置图片模型' }));
  expect((screen.getByLabelText('Ark API Key') as HTMLInputElement).value).toBe('');
});
it('结果未知必须单独确认可能重复计费，额度确认不会发起模型请求', async () => {
  const op: ImageOperationView = {
    id: 'op',
    callId: 'call',
    status: 'outcomeUnknown',
    model: 'flash',
    artifactId: null,
    parentId: null,
    width: null,
    height: null,
    errorCode: 'IMAGE_OUTCOME_UNKNOWN',
    submitted: true,
  };
  const ack = vi.fn(async () => {}),
    extend = vi.fn(async () => {});
  render(
    <ImageOperationCard
      ports={{
        getImageOperations: async () => [op],
        acknowledgeImageOutcome: ack,
        extendImageBudget: extend,
      }}
      threadId="thread"
      callId="call"
    />,
  );
  await screen.findByText('结果未知，可能已计费');
  fireEvent.click(screen.getByText('确认可能重复计费后再生成'));
  expect(ack).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('确认'));
  await waitFor(() => expect(ack).toHaveBeenCalledWith({ threadId: 'thread', operationId: 'op' }));
  expect(extend).not.toHaveBeenCalled();
});

it('connection verification is explicit and read only', async () => {
  const verifyImageConnection = vi.fn(async () => '目录验证通过，未生成图片');
  render(
    <ImageSettings
      ports={{
        getImageSettings: async () => ({ ...view, enabled: true, hasKey: true }),
        verifyImageConnection,
      }}
    />,
  );
  await screen.findByRole('checkbox');
  expect(verifyImageConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '配置图片模型' }));
  fireEvent.click(screen.getByText('测试已保存配置'));
  await screen.findByText('目录验证通过，未生成图片');
  expect(verifyImageConnection).toHaveBeenCalledTimes(1);
});

it('completed indexed PNG previews and continues editing the exact artifact without automatic submission', async () => {
  const edit = vi.fn(),
    open = vi.fn();
  render(
    <ImageOperationCard
      ports={{
        getImageOperations: async () => [
          {
            id: 'op',
            callId: 'call',
            status: 'completed',
            model: 'flash',
            artifactId: 'artifact',
            parentId: null,
            width: 2048,
            height: 2048,
            errorCode: null,
            submitted: true,
          },
        ],
        readResultPreview: async () => ({
          name: 'AI 图片',
          kind: 'image',
          content: 'data:image/png;base64,aGVsbG8=',
        }),
      }}
      threadId="thread"
      callId="call"
      onEdit={edit}
      onOpen={open}
    />,
  );
  const image = await screen.findByAltText('AI 生成的图片');
  expect(image.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
  expect(edit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('继续修改'));
  expect(edit).toHaveBeenCalledWith('artifact');
  fireEvent.click(screen.getByText('打开图片'));
  expect(open).toHaveBeenCalledWith('artifact');
});

it('图片草稿不改变已保存设置，失败保留草稿，测试按钮只验证已保存配置', async () => {
  const saveImageSettings = vi.fn(async () => {
    throw new Error('图片服务正在使用中，请稍后保存。');
  });
  const verifyImageConnection = vi.fn(async () => '已验证');
  const onFormState = vi.fn();
  render(
    <ImageSettings
      onFormState={onFormState}
      ports={{
        getImageSettings: async () => ({ ...view, enabled: true, hasKey: true }),
        saveImageSettings,
        verifyImageConnection,
      }}
    />,
  );
  await screen.findByRole('button', { name: '配置图片模型' });
  fireEvent.click(screen.getByRole('button', { name: '配置图片模型' }));
  fireEvent.change(screen.getByLabelText('图片接口地址'), {
    target: { value: 'https://different.example/api/v3/' },
  });
  fireEvent.change(screen.getByLabelText('Ark API Key'), { target: { value: 'test-draft-only' } });
  expect(saveImageSettings).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('button', { name: '测试已保存配置' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '保存图片设置' }));
  await screen.findByText('图片服务正在使用中，请稍后保存。');
  expect((screen.getByLabelText('Ark API Key') as HTMLInputElement).value).toBe('test-draft-only');
  expect((screen.getByLabelText('图片接口地址') as HTMLInputElement).value).toBe(
    'https://different.example/api/v3/',
  );
  expect(verifyImageConnection).not.toHaveBeenCalled();
  // 错误文案出现后，表单状态的 effect 仍可能尚未通知父组件。
  await waitFor(() => expect(onFormState).toHaveBeenLastCalledWith({ dirty: true, busy: false }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onFormState).toHaveBeenLastCalledWith({ dirty: false, busy: false });
});

it('启用图片保存失败时仍为关闭状态，不伪报成功', async () => {
  render(
    <ImageSettings
      ports={{
        getImageSettings: async () => view,
        saveImageSettings: async () => {
          throw new Error('系统密钥库不可用。');
        },
      }}
    />,
  );
  const checkbox = await screen.findByRole('checkbox');
  fireEvent.click(checkbox);
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  await screen.findByRole('alert');
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByText('已保存。')).toBeNull();
});
