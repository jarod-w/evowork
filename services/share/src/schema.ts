/**
 * 分享托管的 sqlite schema。
 *
 * ## 这是云端唯一存**内容**的地方，所以它必须是独立服务
 *
 * `services/identity` 的 DDL 被 `no-content-schema.test.ts` 守着：不许出现能装
 * 任务 / 产物 / prompt 的列。那条测试是「管理端结构上看不到内容」这个对外承诺的实现处。
 * 把分享的文件字节塞进 identity 就会同时破掉那条测试和那句承诺 ——
 * 所以分享托管是 D9 四条云端职责里**自己一条**，也就自己一个服务。
 *
 * ## 这里**没有文件名**
 *
 * `services/artifacts/src/upload.ts` 只上传 `x-evowork-name-digest`，理由写在那边：
 * 文件名可能本身就是敏感信息（「XX公司裁员名单.xlsx」）。这条在服务端的落点就是
 * **DDL 里没有 name 列** —— 想记就得先改这份 DDL，而改它会被
 * `test/no-name-column.test.ts` 拦下来。
 *
 * 接收方看到的文件名来自**链接片段**（`/s/<id>#<name>`），浏览器不会把 `#` 之后的内容
 * 发给服务器。细则见 08 §7.5。
 */
export const SHARE_DDL = `
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  tenant TEXT NOT NULL,
  name_digest TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  visit_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS shares_expiry ON shares (expires_at);

-- 密码校验通过后换到的一次性凭据。短寿命，且**不进 cookie**：
-- 分享页不该给接收方的浏览器种任何长期状态。
CREATE TABLE IF NOT EXISTS grants (
  token_hash TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS grants_expiry ON grants (expires_at);
`;
