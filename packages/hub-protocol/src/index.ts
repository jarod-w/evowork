/**
 * @evowork/hub-protocol —— 插件 Hub 的索引协议（13 §4）。
 *
 * **无网络、无存储、无 Electron。** 拉取在 `services/hub-client`，合并与更新判定在
 * `services/catalog`，签名发布在 `evowork-hub` 仓库的 CI —— 三方共用这一份形状，
 * 任何一方自己抄一份类型，改一个字段名就会在运行时静默断掉。
 */
export {
  encodeHubIndexPayload,
  HUB_SCHEMA_VER,
  isUpstreamPackage,
  MAX_PACKAGE_BYTES,
  parseHubIndexPayload,
  signHubIndex,
  verifyHubIndex,
  type HostedPackage,
  type HubAudit,
  type HubIndexEnvelope,
  type HubIndexPayload,
  type HubInterface,
  type HubItem,
  type HubItemKind,
  type HubLicense,
  type HubPackage,
  type HubRevocation,
  type HubRiskLevel,
  type TrustedHubKey,
  type UpstreamPackage,
  type VerifyHubIndexResult,
} from './index-format.js';
export {
  DEFAULT_UNPACK_LIMITS,
  packTarGz,
  sha256Hex,
  treeSha256,
  unpackTar,
  unpackTarGz,
  type TarFile,
  type UnpackLimits,
  type UnpackResult,
} from './tar.js';
export {
  compareVersions,
  isValidRange,
  isVersion,
  matchesRange,
  parseVersion,
  type Version,
} from './version.js';
