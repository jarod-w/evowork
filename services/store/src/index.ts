/**
 * @evowork/store —— 本机数据模型（M2a）。
 *
 * 存在理由不是"缓存优化"，而是**协议缺口**：`thread/list` 没有状态与日期过滤（F8），
 * `ThreadExtra` 是空结构体、没有客户端元数据槽（F9）。派生状态、场景、产物计数、分享状态
 * 只能落在这里。
 *
 * 三条纪律：
 *   ① **两个迁移器**（`migrate.ts`）—— 投影类可丢弃重建，权威类宁可启动失败也不丢；
 *   ② **筛选先查 id、再用 `thread/list` 拉权威字段**（`projection.ts` 只暴露 id 查询）；
 *   ③ **不记正文** —— 连未识别通知也只记形状指纹（`store.ts` 的 `recordUnknownEvent`）。
 */
export { deriveStatus, STATUS_LABEL, type DeriveInput } from './derive-status.js';
export {
  AUTHORITATIVE_MIGRATIONS,
  AUTHORITATIVE_VERSION,
  AuthoritativeMigrationFailed,
  PROJECTION_MIGRATIONS,
  PROJECTION_VERSION,
  dropProjectionTables,
  ensureMeta,
  migrateAuthoritative,
  migrateProjection,
  pruneBackups,
  readMeta,
  writeMeta,
  type AuthoritativeMigrateOptions,
  type Migration,
  type MigrationOutcome,
  type SqliteLike,
} from './migrate.js';
export {
  ThreadProjection,
  type ProjectionRow,
  type ThreadFilter,
  type ThreadOrigin,
} from './projection.js';
export {
  AUTHORITATIVE_TABLES,
  DERIVED_STATUS,
  PROJECTION_TABLES,
  TABLES,
  type DerivedStatus,
  type TableClass,
  type TableSpec,
} from './schema.js';
export {
  SCHEMA_VERSIONS,
  openStore,
  type ItemDigestEntry,
  type OpenStoreOptions,
  type Store,
} from './store.js';
export * from './repositories.js';
