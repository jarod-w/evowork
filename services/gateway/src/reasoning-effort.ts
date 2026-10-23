import type { ProviderId } from './capabilities.js';

export function supportsReasoningEffort(provider: ProviderId | undefined, model: string): boolean {
  return (
    (provider === 'deepseek' &&
      [
        'deepseek-flash',
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp',
        'deepseek-v4-pro',
      ].includes(model)) ||
    (provider === 'moonshot' && model === 'kimi-k3') ||
    (provider === 'zhipu' &&
      ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'].includes(model.toLowerCase()))
  );
}

export function mapReasoningEffort(
  provider: ProviderId | undefined,
  model: string,
  effort: string,
): string | undefined {
  if (!supportsReasoningEffort(provider, model)) return undefined;
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort))
    return undefined;
  if (provider === 'deepseek')
    return (
      {
        none: 'none',
        minimal: 'low',
        low: 'low',
        medium: 'high',
        high: 'high',
        xhigh: 'high',
        max: 'max',
        ultra: 'max',
      } as Record<string, string>
    )[effort];
  return (
    {
      minimal: 'low',
      low: 'low',
      medium: 'high',
      high: 'high',
      xhigh: 'max',
      max: 'max',
      ultra: 'max',
    } as Record<string, string>
  )[effort];
}

export function reasoningEffortNotice(provider: ProviderId | undefined, model: string): string {
  if (!supportsReasoningEffort(provider, model))
    return '这个模型的推理强度调节尚未核实，采用模型服务的默认强度。';
  return '厂商支持低、高、最高三档推理强度；场景中的中等强度按高档执行。';
}
