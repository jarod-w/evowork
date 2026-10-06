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
  const saveImageSettings = vi.fn(async () => ({ ...view, enabled: true, hasKey: true }));
  render(<ImageSettings ports={{ getImageSettings: async () => view, saveImageSettings }} />);
  const toggle = await screen.findByRole('checkbox');
  expect((toggle as HTMLInputElement).checked).toBe(false);
  fireEvent.click(toggle);
  fireEvent.change(screen.getByLabelText('Ark API Key'), { target: { value: 'test-only-key' } });
  fireEvent.click(screen.getByText('保存图片设置'));
  await waitFor(() =>
    expect(saveImageSettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, apiKey: 'test-only-key', model: 'flash' }),
    ),
  );
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
  fireEvent.click(screen.getByText('验证型号与凭据'));
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
