/**
 * 本机 sqlite 的表定义（09 §4）。
 *
 * **两类表，必须在代码里显式区分**（09 §4.6 的原话：不显式区分的话，"重建索引"的逻辑
 * 总有一天会把 automation 表也清了）：
 *
 * | 类别 | 真源在哪 | 迁移失败时 | 表 |
 * |---|---|---|---|
 * | 投影类 | 内核 / 文件系统 | **丢弃重建**，不阻塞启动 | `thread_projection` `item_digest` `library_index` `library_node` `access_log` `unknown_event` |
 * | 权威类 | 只在这里 | 备份 → 失败则回滚并报错 | `automation` `automation_run` `share` `audit_log` `subscription` `notification` `artifact` |
 *
 * `artifact` 归**权威类**是一个需要说明的判断：产物**本体**的真源是文件系统（D6），
 * 但索引里的 `title`（可重命名而不改文件名）、`version` 链、`share_id`、`source_signal`
 * 这些在磁盘上没有对应物 —— 丢了就再也推不出来。所以它是"指向文件的权威元数据"。
 */

export type TableClass = 'projection' | 'authoritative';

export interface TableSpec {
  readonly name: string;
  readonly klass: TableClass;
  readonly ddl: readonly string[];
}

/** 派生状态。前七个来自 04 §2.2 的派生规则表。 */
export const DERIVED_STATUS = [
  'running',
  'pending',
  'planning',
  'completed',
  'failed',
  'interrupted',
  'archived',
  /**
   * `idle` 是实现补充的第八个值（已回写 09 §4.1）：thread 已创建但还没有任何回合。
   * 首页只在首次发送时才 `thread/start`（03 §1），所以这个状态很短暂，
   * 但 `thread/fork`、`thread/resume` 之后都可能出现，UI 上对应 04 §8 的"任务无消息"空态。
   * 不给它一个名字的话，它会被塞进 `running` 或 `completed`，两种都是谎话。
   */
  'idle',
] as const;

export type DerivedStatus = (typeof DERIVED_STATUS)[number];

export const TABLES: readonly TableSpec[] = [
  // ───────────────────────── 投影类 ─────────────────────────
  {
    name: 'thread_projection',
    klass: 'projection',
    ddl: [
      `CREATE TABLE IF NOT EXISTS thread_projection (
         thread_id        TEXT PRIMARY KEY,
         title            TEXT,
         cwd              TEXT,
         project_id       TEXT,
         section_id       TEXT,
         -- 以下是内核给不了的部分（F7/F8/F9）
         derived_status   TEXT NOT NULL,
         last_turn_status TEXT,
         last_turn_id     TEXT,
         scenario_id      TEXT,
         mode_id          TEXT,
         permission_id    TEXT,
         model            TEXT,
         plan_confirmed   INTEGER NOT NULL DEFAULT 0,
         has_plan_item    INTEGER NOT NULL DEFAULT 0,
         automation_id    TEXT,
         artifact_count   INTEGER NOT NULL DEFAULT 0,
         token_input      INTEGER NOT NULL DEFAULT 0,
         token_output     INTEGER NOT NULL DEFAULT 0,
         token_cached     INTEGER NOT NULL DEFAULT 0,
         cost_estimate    REAL NOT NULL DEFAULT 0,
         budget_limit     INTEGER,
         share_id         TEXT,
         first_message    TEXT,
         parent_thread_id TEXT,
         created_at       INTEGER,
         updated_at       INTEGER,
         recency_at       INTEGER,
         archived         INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS ix_tp_status ON thread_projection(derived_status, recency_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ix_tp_updated ON thread_projection(updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ix_tp_cwd ON thread_projection(cwd, recency_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ix_tp_auto ON thread_projection(automation_id, created_at DESC)`,
    ],
  },
  {
    name: 'item_digest',
    klass: 'projection',
    ddl: [
      // 只存最近 50 条的一行摘要，用于 04 §9 的"< 300ms 出内容"。**不是权威副本**：
      // 打开任务后立刻用 thread/items/list 校正。
      `CREATE TABLE IF NOT EXISTS item_digest (
         thread_id  TEXT NOT NULL,
         seq        INTEGER NOT NULL,
         item_id    TEXT NOT NULL,
         item_type  TEXT NOT NULL,
         summary    TEXT,
         created_at INTEGER,
         PRIMARY KEY (thread_id, seq)
       )`,
      `CREATE INDEX IF NOT EXISTS ix_id_thread ON item_digest(thread_id, seq DESC)`,
    ],
  },
  {
    name: 'library_node',
    klass: 'projection',
    ddl: [
      // 「我的资料」与团队空间缓存的节点树（06 §6）。真源是磁盘目录，可重建。
      `CREATE TABLE IF NOT EXISTS library_node (
         node_id     TEXT PRIMARY KEY,
         parent_id   TEXT,
         kind        TEXT NOT NULL,          -- folder | file
         source      TEXT NOT NULL,          -- mine | team | artifact
         path        TEXT NOT NULL,
         title       TEXT,
         read_only   INTEGER NOT NULL DEFAULT 0,
         subscription_id TEXT,
         size_bytes  INTEGER,
         updated_at  INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS ix_ln_parent ON library_node(parent_id)`,
    ],
  },
  {
    name: 'library_index',
    klass: 'projection',
    ddl: [
      // FTS5 全文索引（06 §3.4）。node:sqlite 自带 FTS5（2026-09-05 实测）。
      //
      // **tokenize = trigram 是为中文选的，不是默认值**：FTS5 的默认 unicode61 分词器
      // 按空白与标点切词，中文一整段会变成一个 token —— 搜「毛利率」匹配不到
      // 「毛利率与欠款风险」。实测确认过这一点（这条 DDL 的第一版就是默认分词器，测试直接红了）。
      //
      // 代价必须说清，它会影响 06 §3.4 的搜索体验：
      //   · trigram 要求查询词**至少 3 个字符**；1–2 字的查询 FTS 查不到，
      //     需要在查询层回落到 LIKE（见 06 的搜索实现，M8）；
      //   · 索引体积比 unicode61 大（每 3 字一个 token）；
      //   · 大小写与变音符号不敏感（对中文无影响，对英文正好是想要的）。
      `CREATE VIRTUAL TABLE IF NOT EXISTS library_index USING fts5(
         node_id UNINDEXED,
         title,
         body,
         meta UNINDEXED,
         tokenize = 'trigram'
       )`,
    ],
  },
  {
    name: 'access_log',
    klass: 'projection',
    ddl: [
      `CREATE TABLE IF NOT EXISTS access_log (
         id        INTEGER PRIMARY KEY AUTOINCREMENT,
         node_id   TEXT NOT NULL,
         opened_at INTEGER NOT NULL,
         from_page TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS ix_al_time ON access_log(opened_at DESC)`,
    ],
  },
  {
    name: 'unknown_event',
    klass: 'projection',
    ddl: [
      // R2 的上游变更雷达（09 §3.4 最后一行）：未识别的通知记原始 JSON，每日聚合一条日志。
      // 存原始 JSON 是这里唯一允许存正文的地方吗？不是 —— 见 store.ts 的 recordUnknownEvent()：
      // 只存方法名与形状指纹，不存 params。
      `CREATE TABLE IF NOT EXISTS unknown_event (
         method      TEXT NOT NULL,
         shape       TEXT NOT NULL,
         first_seen  INTEGER NOT NULL,
         last_seen   INTEGER NOT NULL,
         hits        INTEGER NOT NULL DEFAULT 1,
         PRIMARY KEY (method, shape)
       )`,
    ],
  },

  // ───────────────────────── 权威类 ─────────────────────────
  {
    name: 'artifact',
    klass: 'authoritative',
    ddl: [
      // 08 §2.4。**没有 content 字段** —— 索引不存内容（D6：文件系统是真源）。
      `CREATE TABLE IF NOT EXISTS artifact (
         id             TEXT PRIMARY KEY,
         thread_id      TEXT,
         turn_id        TEXT,
         automation_id  TEXT,
         path           TEXT NOT NULL,
         artifact_type  TEXT NOT NULL,
         output_format  TEXT,
         title          TEXT,
         operation_kind TEXT,
         size_bytes     INTEGER,
         content_hash   TEXT,
         version        INTEGER NOT NULL DEFAULT 1,
         supersedes_id  TEXT,
         source_signal  TEXT NOT NULL,   -- SKILL_REPORT | FILE_CHANGE | HOOK_SCAN
         file_state     TEXT NOT NULL DEFAULT 'PRESENT',  -- PRESENT | MISSING | MOVED
         share_id       TEXT,
         created_at     INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS ix_af_thread ON artifact(thread_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ix_af_path ON artifact(path, version DESC)`,
    ],
  },
  {
    name: 'automation',
    klass: 'authoritative',
    ddl: [
      // 总纲 §6.9 + Q15 的 device_id。**丢了就是丢了定时任务定义**，所以是权威类。
      `CREATE TABLE IF NOT EXISTS automation (
         id                   TEXT PRIMARY KEY,
         tenant_id            TEXT,
         owner_id             TEXT,
         name                 TEXT NOT NULL,
         device_id            TEXT NOT NULL,
         prompt               TEXT NOT NULL,
         workspaces           TEXT NOT NULL,   -- JSON 数组（本机绝对路径）
         schedule             TEXT NOT NULL,   -- cron 或 once@timestamp
         timezone             TEXT NOT NULL,   -- 显式存储，不依赖运行时系统时区（07 §3.2）
         valid_from           INTEGER,
         valid_until          INTEGER,
         status               TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | PAUSED
         concurrency_policy   TEXT NOT NULL DEFAULT 'SKIP',     -- Q8 固定值
         retry_policy         TEXT NOT NULL DEFAULT 'NONE',     -- Q8：失败不自动重试
         consecutive_failures INTEGER NOT NULL DEFAULT 0,
         misfire_policy       TEXT NOT NULL DEFAULT 'FIRE_ONCE_ON_WAKE',
         catchup_window_ms    INTEGER NOT NULL DEFAULT 86400000,
         wake_system          INTEGER NOT NULL DEFAULT 0,
         budget_limit         INTEGER NOT NULL,                 -- 07 §8-3：定时任务强制硬预算
         model                TEXT,
         permission_id        TEXT,
         mode_id              TEXT,
         scenario_id          TEXT,
         last_fire_time       INTEGER,
         created_at           INTEGER NOT NULL,
         updated_at           INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS ix_au_device ON automation(device_id, status)`,
    ],
  },
  {
    name: 'automation_run',
    klass: 'authoritative',
    ddl: [
      // 07 §8 的三个增量字段已在此：trigger / original_fire_time / failure_class
      `CREATE TABLE IF NOT EXISTS automation_run (
         id                 TEXT PRIMARY KEY,
         automation_id      TEXT NOT NULL,
         fire_time          INTEGER NOT NULL,
         thread_id          TEXT,
         status             TEXT NOT NULL,   -- RUNNING|SUCCEEDED|FAILED|SKIPPED|MISSED
         skip_reason        TEXT,            -- CONCURRENCY|MACHINE_OFFLINE|OUT_OF_WINDOW|QUOTA
         trigger            TEXT NOT NULL,   -- SCHEDULED|MANUAL|MANUAL_TEST|CATCHUP
         original_fire_time INTEGER,
         failure_class      TEXT,            -- MODEL|SCRIPT|APPROVAL_TIMEOUT|ENVIRONMENT|QUOTA
         token_usage        INTEGER,
         cost               REAL,
         error_summary      TEXT,
         started_at         INTEGER,
         finished_at        INTEGER
       )`,
      /*
       * 幂等键（D5 / 09 §6.2）：单机单进程，有这条唯一索引就不需要分布式锁。
       *
       * **`trigger` 必须在键里**（2026-09-05 修订，已回写总纲 §6.9）。
       * 原设计写的是 `automation_id + fire_time` 两列，但它与 07 §8-1 的
       * 「先写 MISSED 再补跑」直接冲突：那两条记录**共享同一个 fire_time**
       * （补跑的 `original_fire_time` 就是被错过的那个时刻），于是补跑那条插不进去，
       * 表现是"历史里只有一条『错过』，任务再也没跑"。
       *
       * 这是接线时被端到端测试抓出来的 —— 两个模块各自都对，合起来才不对。
       */
      `CREATE UNIQUE INDEX IF NOT EXISTS ix_run_idem ON automation_run(automation_id, fire_time, trigger)`,
      `CREATE INDEX IF NOT EXISTS ix_run_recent ON automation_run(automation_id, fire_time DESC)`,
    ],
  },
  {
    name: 'share',
    klass: 'authoritative',
    ddl: [
      // 08 §7。撤销状态与有效期是权威信息：丢了就没法撤销已经发出去的链接。
      `CREATE TABLE IF NOT EXISTS share (
         id           TEXT PRIMARY KEY,
         artifact_id  TEXT,
         thread_id    TEXT,
         url          TEXT NOT NULL,
         expires_at   INTEGER NOT NULL,
         has_password INTEGER NOT NULL DEFAULT 0,
         visit_count  INTEGER NOT NULL DEFAULT 0,
         revoked_at   INTEGER,
         created_at   INTEGER NOT NULL
       )`,
    ],
  },
  {
    name: 'subscription',
    klass: 'authoritative',
    ddl: [
      // 私有源订阅（05 / 06）。签名指纹是信任的锚点，丢了要重新走一次信任流程。
      `CREATE TABLE IF NOT EXISTS subscription (
         id                    TEXT PRIMARY KEY,
         source_url            TEXT NOT NULL,
         dataset_id            TEXT,
         kind                  TEXT NOT NULL,   -- skills | library
         version               TEXT,
         signature_fingerprint TEXT,
         last_synced_at        INTEGER,
         created_at            INTEGER NOT NULL
       )`,
    ],
  },
  {
    name: 'notification',
    klass: 'authoritative',
    ddl: [
      // 02 §5.1。通知全部落本机表，云端不推送内容（K6）。
      `CREATE TABLE IF NOT EXISTS notification (
         id         TEXT PRIMARY KEY,
         kind       TEXT NOT NULL,
         thread_id  TEXT,
         automation_id TEXT,
         title      TEXT NOT NULL,
         body       TEXT,
         deeplink   TEXT,
         read_at    INTEGER,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS ix_nt_unread ON notification(read_at, created_at DESC)`,
    ],
  },
  {
    name: 'audit_log',
    klass: 'authoritative',
    ddl: [
      // 10 §6。记什么/不记什么见那一节：**不记 prompt 正文、文件内容、命令完整输出**。
      // agent_identity 与 verification_ref 是 Q12「保留接口不实现」的具体含义：预留两列、不写入。
      `CREATE TABLE IF NOT EXISTS audit_log (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         occurred_at     INTEGER NOT NULL,
         thread_id       TEXT,
         turn_id         TEXT,
         item_id         TEXT,
         tool_name       TEXT,
         action_summary  TEXT,
         path_kind       TEXT,
         path_digest     TEXT,
         network_target  TEXT,
         approval_result TEXT,
         decided_by      TEXT,
         guardian_risk   TEXT,
         exit_code       INTEGER,
         token_usage     INTEGER,
         agent_identity  TEXT,
         verification_ref TEXT,
         chain_hash      TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS ix_audit_time ON audit_log(occurred_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ix_audit_thread ON audit_log(thread_id, occurred_at DESC)`,
    ],
  },
];

export const PROJECTION_TABLES = TABLES.filter((t) => t.klass === 'projection');
export const AUTHORITATIVE_TABLES = TABLES.filter((t) => t.klass === 'authoritative');
