/**
 * 「下拉里该选中哪一个」—— 纯策略，不碰网络也不碰 React。
 *
 * 放在渲染层是因为它回答的是一个 UI 问题（选中项），而它依赖的输入
 * （当前场景的默认模型）只有渲染层知道 —— 用户随时会切场景。
 * 主进程那边（`main/model-catalog.ts`）只负责取回列表并翻译形状。
 *
 * 单独一个文件、导出成普通函数，是为了能直接测「场景默认值不可用时会发生什么」——
 * 那条路径要通过 UI 触发的话，得先造出一个"网关里没有这个模型"的环境。
 */
import type { ModelOptionView } from '../shared/ipc.js';

export interface ModelChoice {
  readonly modelId?: string | undefined;
  /**
   * 需要显示给用户的话。
   *
   * 只有一种情况非空：**场景默认的模型当前不可用，我们换了一个**。
   * 这句话不能省 —— 静默换模型正是 03 §8 与 D2 都禁止的那件事：
   * 用户以为在用 A、实际在用 B，而账单与产物质量都不一样（U1 就是关于产物质量的）。
   */
  readonly notice?: string | undefined;
}

/**
 * 选哪个模型：**优先用户已选的，其次场景默认值，最后第一个可用的**。
 *
 * `chosen` 是用户显式选过的那个（03 §2.5 的"已被你改过"）。它在列表里就一直生效，
 * 切场景也不改 —— 场景默认值只在用户没选过时才有发言权。
 *
 * 一个模型都没有时返回空：此时 Composer 已经因为 `unavailable` 禁用了发送，
 * 再挑一个不存在的 id 只会让"发出去说模型不存在"晚一步发生。
 */
export function resolveModelChoice(
  models: readonly ModelOptionView[],
  chosen: string | undefined,
  scenarioDefault: string | undefined,
): ModelChoice {
  if (models.length === 0) return {};
  if (chosen && models.some((m) => m.id === chosen)) return { modelId: chosen };

  const first = models[0] as ModelOptionView;
  if (!scenarioDefault) return { modelId: first.id };
  if (models.some((m) => m.id === scenarioDefault)) return { modelId: scenarioDefault };
  return {
    modelId: first.id,
    notice: `场景默认的模型「${scenarioDefault}」当前不可用（网关没有它，或那家厂商的密钥没配），已改用「${first.label}」。`,
  };
}
