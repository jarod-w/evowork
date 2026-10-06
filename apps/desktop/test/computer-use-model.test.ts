import { describe, expect, it } from 'vitest';
import { computerUseModelContext } from '../src/main/computer-use-model.js';
import type { ModelOptionView } from '../src/shared/ipc.js';
describe('电脑操控使用当前目录的模型能力与凭据', () => {
  it('支持图片的模型可截图；模型撤销/禁用后不沿用旧能力', () => {
    const model: ModelOptionView = {
      id: 'model',
      provider: 'provider',
      label: '模型',
      capabilities: [{ id: 'image-input', label: '读图', available: true }],
      notices: [],
      credentialSource: 'byok',
      verified: true,
    };
    expect(computerUseModelContext('model', [model])).toMatchObject({
      imageSupported: true,
      credentialSource: '用户自有模型密钥（provider）',
    });
    expect(computerUseModelContext('model', [])).toMatchObject({ imageSupported: false });
    expect(computerUseModelContext('model', [{ ...model, denied: '企业禁用' }])).toMatchObject({
      imageSupported: false,
    });
    expect(
      computerUseModelContext('model', [
        {
          ...model,
          capabilities: [{ id: 'image-input', label: '读图', available: false }],
          credentialSource: 'private',
        },
      ]),
    ).toMatchObject({ imageSupported: false, credentialSource: '私有模型服务凭据（provider）' });
  });
});
