/**
 * 官方「EvoWork 精选」源的接入参数（13 §4.3 / §4.6）。
 *
 * ## 公钥钉死在这里；地址有默认值，部署可以换
 *
 * 信任根是**公钥**，不是地址：地址默认是 `https://hub.nucleant.cn`（2026-10-03 以 `:9443` 上线，
 * 2026-10-07 随服务器迁移改成默认端口，build-and-deploy §5.3.2），测试 / 预发 / 企业可以用 `EVOWORK_HUB_ORIGIN` 换成别的；
 * 而公钥只能随 App 分发并钉死（4.3）。所以环境变量**能换地址、不能加钥匙** ——
 * 指到一个假源上，它签的索引照样验不过。
 *
 * ## 两把钥匙
 *
 * `evowork-hub-1` 日常签名，私钥在发版机上（仓库之外）；`evowork-hub-2` 是备份，私钥离线保存、
 * 平时不用。两把都钉在这里：日常那把泄露时，换备份那把签、再发一版删掉泄露的那把 ——
 * 不会出现「新版本还没发出去，所有人都装不了东西」的空窗（4.3 的轮换）。
 */
import { BUNDLE_BASE_URL, type HubSource } from '@evowork/hub-client';
import type { TrustedHubKey } from '@evowork/hub-protocol';

export const OFFICIAL_HUB_SOURCE_ID = 'evowork';
export const OFFICIAL_HUB_NAME = 'EvoWork 精选';

/** 官方源的默认地址（试点期与更新源同一台机器，按 SNI 共用 443）。 */
export const OFFICIAL_HUB_ORIGIN = 'https://hub.nucleant.cn';

/**
 * 2026-10-07 重新生成（P-256 / ES256）：10-03 那一对的日常私钥在发版机上丢了，而钉着它的版本一个都没发出去，
 * 所以直接整对换掉、沿用两个 kid（13 §4.3 有记录）。SPKI 的 sha256，用来认出私钥文件是不是这一对：
 * `evowork-hub-1` 5c83e7922389dd7cec6ac873dccd14f5bed435240feccf8f6ad8ecf0d2d50e94
 * `evowork-hub-2` 580f7c1f3640d86730c6bd614f111eca45bbf137256b9390f5aa25024832c7c9
 *
 * **改这里 = 换信任根**，要走发版、要在 13 §4.3 留记录。
 */
export const OFFICIAL_HUB_KEYS: readonly TrustedHubKey[] = Object.freeze([
  {
    kid: 'evowork-hub-1',
    publicPem: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEewx3HFNeGn5ts+ggZvQJu4YLm661
8Yv1/R36uNetYgzIXEqI/wBuJpwMpa13oqrQNaGJFwuqgVRpT0KnjemXNw==
-----END PUBLIC KEY-----
`,
  },
  {
    kid: 'evowork-hub-2',
    publicPem: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEEYVJWaK11VV+H7nMrlutkWdkVodE
wBavIMbLk/EByv1HWAXPmmEISBXeuKC4vmfPxrTWu8BfobeF6OQFPtcPsg==
-----END PUBLIC KEY-----
`,
  },
]);

export function officialHubSource(
  env: NodeJS.ProcessEnv,
  keys: readonly TrustedHubKey[] = OFFICIAL_HUB_KEYS,
): HubSource | undefined {
  const origin = env.EVOWORK_HUB_ORIGIN?.trim() || OFFICIAL_HUB_ORIGIN;
  if (keys.length === 0) return undefined;
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

/**
 * 4.7 ③：`EVOWORK_HUB_BUNDLE` 指向企业离线包目录。有它时**只读这个目录，一个字节都不出网**；
 * 签名照验（用的还是钉死的公钥），所以离线包在内网被改过同样装不上。
 * 公钥列表为空时离线包也用不了 —— 验不过的东西不该装。
 */
export function offlineHubSource(
  env: NodeJS.ProcessEnv,
  keys: readonly TrustedHubKey[] = OFFICIAL_HUB_KEYS,
): { readonly dir: string; readonly source: HubSource } | undefined {
  const dir = env.EVOWORK_HUB_BUNDLE?.trim();
  if (dir === undefined || dir === '' || keys.length === 0) return undefined;
  return {
    dir,
    source: { id: OFFICIAL_HUB_SOURCE_ID, baseUrl: BUNDLE_BASE_URL, trustedKeys: keys },
  };
}
