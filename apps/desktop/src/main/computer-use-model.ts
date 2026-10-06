import type { ModelOptionView } from '../shared/ipc.js';

/** 使用网关目录同一份能力与凭据元数据；未知/不可用模型按不支持处理。 */
export function computerUseModelContext(modelId: string, models: readonly ModelOptionView[]) {
  const model = models.find((entry) => entry.id === modelId && !entry.denied);
  const sources = { byok: '用户自有模型密钥', hosted: '托管模型凭据', private: '私有模型服务凭据' };
  return {
    imageSupported:
      model?.capabilities.some(
        (capability) => capability.id === 'image-input' && capability.available,
      ) ?? false,
    credentialSource: model
      ? `${sources[model.credentialSource]}（${model.provider}）`
      : '未知凭据来源',
  };
}
