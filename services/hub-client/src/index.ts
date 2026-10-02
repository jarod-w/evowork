/**
 * @evowork/hub-client —— 插件 Hub 的下行通道（13 §5.1）。
 *
 * **K6 登记：唯一为 Hub 出网的包。** 合并、审计、更新判定在 `@evowork/catalog`（不出网），
 * 理由与 runtime-installer 不放进 ingest 一样：让 catalog 能被「整目录扫不出出网调用」守住。
 */
export {
  downloadItem,
  readCachedIndex,
  refreshIndex,
  type DownloadResult,
  type FetchLike,
  type FetchResponseLike,
  type HubClientPorts,
  type HubFs,
  type HubSource,
  type RefreshOutcome,
  type VerifiedIndex,
} from './client.js';
export { createNodeHubPorts, nodeHubFetch, nodeHubFs } from './node.js';
