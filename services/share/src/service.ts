/**
 * 分享托管的用例层。HTTP 只做路由，决策在这里，所以测试不用起服务器。
 *
 * 上传侧的契约是 `services/artifacts/src/upload.ts` 里那份（已经写好很久、一直没有服务端）：
 *   · `PUT /v1/shares` + `x-evowork-share-id` / `x-evowork-name-digest` /
 *     `x-evowork-expires-at` / 可选 `x-evowork-password`（哈希，不是明文）
 *   · `DELETE /v1/shares/:id`
 *
 * 读取侧是给**没有账号的接收方**用的，所以另开一组 `/v1/s/*`：
 * 它们不认 `authorization`，也不种 cookie（11 §13.10 C 第 1 条）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SqliteLike } from './db.js';

/** 单个分享文件的上限，与 `upload.ts` 的 `MAX_SHARE_BYTES` 同一个数。 */
export const MAX_SHARE_BYTES = 200 * 1024 * 1024;

/** 密码换来的下载凭据活多久。够点一下下载，不够拿去传播。 */
export const GRANT_TTL_MS = 10 * 60 * 1000;

/**
 * 可以在浏览器里预览的类型（08 §7.4）。
 *
 * **不含 SVG**：SVG 是可以带脚本的 XML，浏览器会把它当文档跑 ——
 * 它属于"办公文件当网页跑"的同一类破口，只是更隐蔽。
 * 也不含任何 office 类型：那一条是 Q41 的原话，有验收口径第 21 条守着。
 */
export const PREVIEWABLE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export type ShareState = 'active' | 'expired' | 'revoked' | 'missing';

export interface ShareMeta {
  readonly id: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
  readonly hasPassword: boolean;
  readonly previewable: boolean;
}

export interface ShareBlobs {
  put(id: string, bytes: Uint8Array): Promise<void>;
  read(id: string): Promise<Uint8Array | undefined>;
  remove(id: string): Promise<void>;
}

export interface ShareDeps {
  readonly db: SqliteLike;
  readonly blobs: ShareBlobs;
  readonly now?: (() => number) | undefined;
  /** 分享链接的对外前缀，例如 `https://s.evowork.example`。 */
  readonly publicOrigin: string;
}

interface ShareRow {
  id: string;
  owner_sub: string;
  content_type: string;
  size_bytes: number;
  password_hash: string | null;
  expires_at: number;
  revoked_at: number | null;
  visit_count: number;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 定长比较。分享密码的哈希也是凭据，别用 `===` 泄露前缀。 */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createShareService(deps: ShareDeps) {
  const now = () => deps.now?.() ?? Date.now();

  function row(id: string): ShareRow | undefined {
    return deps.db
      .prepare(
        `SELECT id, owner_sub, content_type, size_bytes, password_hash, expires_at, revoked_at, visit_count
         FROM shares WHERE id = ?`,
      )
      .get(id) as ShareRow | undefined;
  }

  function stateOf(found: ShareRow | undefined): ShareState {
    if (!found) return 'missing';
    if (found.revoked_at !== null) return 'revoked';
    if (found.expires_at <= now()) return 'expired';
    return 'active';
  }

  return {
    /**
     * 接收上传。**幂等按 share id**：同一个 id 再传一次就是覆盖，
     * 因为上传失败时 `upload.ts` 会 DELETE 清理，重试不该撞 409。
     */
    async put(input: {
      id: string;
      ownerSub: string;
      tenant: string;
      nameDigest: string;
      contentType: string;
      expiresAt: number;
      passwordHash?: string | undefined;
      bytes: Uint8Array;
    }): Promise<{ ok: true; url: string } | { ok: false; status: number; message: string }> {
      if (input.bytes.byteLength > MAX_SHARE_BYTES) {
        return { ok: false, status: 413, message: '超过分享的 200MB 上限。' };
      }
      if (input.expiresAt <= now()) {
        return { ok: false, status: 400, message: '有效期已经过了。' };
      }
      const existing = row(input.id);
      if (existing && existing.owner_sub !== input.ownerSub) {
        // 撞 id 只可能是碰撞或有人猜 id，两种都不该覆盖别人的东西
        return { ok: false, status: 409, message: '这个分享 id 已经被占用。' };
      }
      await deps.blobs.put(input.id, input.bytes);
      deps.db
        .prepare(
          `INSERT INTO shares
             (id, owner_sub, tenant, name_digest, content_type, size_bytes, password_hash,
              created_at, expires_at, revoked_at, visit_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
           ON CONFLICT(id) DO UPDATE SET
             name_digest = excluded.name_digest,
             content_type = excluded.content_type,
             size_bytes = excluded.size_bytes,
             password_hash = excluded.password_hash,
             expires_at = excluded.expires_at,
             revoked_at = NULL`,
        )
        .run(
          input.id,
          input.ownerSub,
          input.tenant,
          input.nameDigest,
          input.contentType,
          input.bytes.byteLength,
          input.passwordHash ?? null,
          now(),
          input.expiresAt,
        );
      return { ok: true, url: `${deps.publicOrigin.replace(/\/$/, '')}/s/${input.id}` };
    },

    /**
     * 撤销 = 云端删除 + 链接失效（08 §7.2 规则 3）。
     *
     * **字节立刻删掉**，只留一行墓碑：接收方再打开要看到「已撤销」而不是 404，
     * 而"已撤销"与"从来没有过"在页面上都不该透露更多。
     */
    async revoke(id: string, ownerSub: string): Promise<boolean> {
      const found = row(id);
      if (!found || found.owner_sub !== ownerSub) return false;
      await deps.blobs.remove(id);
      deps.db.prepare(`UPDATE shares SET revoked_at = ? WHERE id = ?`).run(now(), id);
      deps.db.prepare(`DELETE FROM grants WHERE share_id = ?`).run(id);
      return true;
    },

    /**
     * 给接收方的元数据。
     *
     * 失效时**只回一个状态**，不回类型、不回大小（08 §7.4：文件名以外的元数据能少则少）。
     * 「已撤销」「已过期」「没有这个链接」三者的返回形状一致，免得拿链接去探测。
     */
    describe(id: string): { state: ShareState; meta?: ShareMeta } {
      const found = row(id);
      const state = stateOf(found);
      if (state !== 'active' || !found) return { state };
      return {
        state,
        meta: {
          id: found.id,
          contentType: found.content_type,
          sizeBytes: found.size_bytes,
          expiresAt: found.expires_at,
          hasPassword: found.password_hash !== null,
          previewable: PREVIEWABLE_TYPES.has(found.content_type),
        },
      };
    },

    /**
     * 用密码哈希换一次性下载凭据。
     *
     * 接收方在浏览器里算 `sha256(shareId:password)` 再发过来 ——
     * **明文密码不离开接收方的浏览器**，与上传侧只传哈希是同一条（`upload.ts` 末尾）。
     */
    unlock(id: string, passwordHash: string): { ok: true; grant: string } | { ok: false } {
      const found = row(id);
      if (stateOf(found) !== 'active' || !found?.password_hash) return { ok: false };
      if (!sameSecret(found.password_hash, passwordHash)) return { ok: false };
      const grant = randomBytes(24).toString('base64url');
      deps.db
        .prepare(`INSERT INTO grants (token_hash, share_id, expires_at) VALUES (?, ?, ?)`)
        .run(sha256Hex(grant), id, now() + GRANT_TTL_MS);
      return { ok: true, grant };
    },

    /**
     * 取字节。密码保护的分享必须带 grant。
     *
     * **密码只挡住获取文件，不因此开通办公文件预览**（Q41）——
     * 那个判断在 `previewable` 上，与这里无关。
     */
    async download(
      id: string,
      grant?: string,
    ): Promise<
      | { ok: true; bytes: Uint8Array; contentType: string; previewable: boolean }
      | { ok: false; state: ShareState | 'locked' }
    > {
      const found = row(id);
      const state = stateOf(found);
      if (state !== 'active' || !found) return { ok: false, state };
      if (found.password_hash !== null) {
        if (!grant) return { ok: false, state: 'locked' };
        const row2 = deps.db
          .prepare(`SELECT share_id, expires_at FROM grants WHERE token_hash = ?`)
          .get(sha256Hex(grant)) as { share_id: string; expires_at: number } | undefined;
        if (!row2 || row2.share_id !== id || row2.expires_at <= now()) {
          return { ok: false, state: 'locked' };
        }
      }
      const bytes = await deps.blobs.read(id);
      if (!bytes) return { ok: false, state: 'missing' };
      deps.db.prepare(`UPDATE shares SET visit_count = visit_count + 1 WHERE id = ?`).run(id);
      return {
        ok: true,
        bytes,
        contentType: found.content_type,
        previewable: PREVIEWABLE_TYPES.has(found.content_type),
      };
    },

    /**
     * 到期自动删除（08 §7.2 规则 4）。
     *
     * 删的是**字节**，行留着并标记 —— 接收方再点链接要看到「已过期」。
     * 只把行删掉的话，过期与"链接打错了"会变成同一个页面。
     */
    async sweep(): Promise<{ removed: number }> {
      const due = deps.db
        .prepare(`SELECT id FROM shares WHERE expires_at <= ? AND revoked_at IS NULL`)
        .all(now()) as { id: string }[];
      for (const item of due) {
        await deps.blobs.remove(item.id);
      }
      deps.db.prepare(`DELETE FROM grants WHERE expires_at <= ?`).run(now());
      return { removed: due.length };
    },

    /** 给「我分享的」对账用：本机那张表是权威，这里只回访问次数。 */
    visits(id: string, ownerSub: string): number | undefined {
      const found = row(id);
      if (!found || found.owner_sub !== ownerSub) return undefined;
      return found.visit_count;
    },
  };
}

export type ShareService = ReturnType<typeof createShareService>;
