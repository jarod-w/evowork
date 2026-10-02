/**
 * 官方「EvoWork 精选」源的接入参数（13 §4.3 / §4.6）。
 *
 * ## 公钥钉死在这里，地址由部署给
 *
 * 信任根是**公钥**，不是地址：地址可以由部署时的环境变量给（与 `EVOWORK_IDENTITY_ORIGIN` 同一口径，
 * 测试 / 预发 / 正式各指各的），而公钥只能随 App 分发并钉死（4.3）。所以环境变量**能换地址、
 * 不能加钥匙** —— 指到一个假源上，它签的索引照样验不过。
 *
 * ## 现在两样都还没有（H2 才有）
 *
 * 离线签名机与 CDN 是 H2 的事（13 §13）。在那之前 `OFFICIAL_HUB_KEYS` 是空的，
 * `officialHubSource` 返回 undefined，「EvoWork 精选」如实显示「这个版本还没有接入」，
 * **一个请求都不发** —— 拉一份注定验不过的索引没有意义，还白白多出一条出网路径。
 *
 * 轮换：新旧 kid 并存一个 App 版本周期；私钥泄露时发版删掉那个 kid（4.3）。
 */
import type { HubSource } from '@evowork/hub-client';
import type { TrustedHubKey } from '@evowork/hub-protocol';

export const OFFICIAL_HUB_SOURCE_ID = 'evowork';
export const OFFICIAL_HUB_NAME = 'EvoWork 精选';

/** H2 发布第一把离线签名密钥时填进来（`{ kid, publicPem }`）。 */
export const OFFICIAL_HUB_KEYS: readonly TrustedHubKey[] = [];

export function officialHubSource(
  env: NodeJS.ProcessEnv,
  keys: readonly TrustedHubKey[] = OFFICIAL_HUB_KEYS,
): HubSource | undefined {
  const origin = env.EVOWORK_HUB_ORIGIN?.trim();
  if (origin === undefined || origin === '' || keys.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  // 只认 https；本机回环地址放行给开发与 E2E
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
  return {
    id: OFFICIAL_HUB_SOURCE_ID,
    baseUrl: `${origin.replace(/\/+$/, '')}/v1`,
    trustedKeys: keys,
  };
}

/** 4.7 ②：MDM 下发时设 `EVOWORK_HUB_OFFICIAL=off`，连「刷新」都不出现。 */
export function officialHubDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.EVOWORK_HUB_OFFICIAL?.trim().toLowerCase() === 'off';
}
