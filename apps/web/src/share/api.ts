/**
 * 分享页的数据层。
 *
 * ## 这个文件**刻意不 import `../api.js`**
 *
 * 那份里有 `readSession` / `writeSession` / `Bearer` 头。分享页要渲染的是
 * 不可信来源的元数据，**它旁边不该放着一把令牌**（11 §13.10 C 第 1 条，验收口径第 25 条）。
 * 靠"我们记得不调用"是守不住的 —— 所以这里另起一份，共享的只有类型名。
 * `apps/web/test/share-isolation.test.ts` 扫这个目录，import 到账号那一侧就红。
 *
 * ## 文件名来自链接片段，不来自服务器
 *
 * 云端**不知道**文件名（`services/share/src/schema.ts`：DDL 里没有 name 列，
 * 上传只带 digest）。接收方看到的名字来自 `/s/<id>#<name>` 的 `#` 之后那一段，
 * 浏览器不会把它发给服务器。
 *
 * 这解掉了 08 §7.4（页面要显示文件名）与 `upload.ts`（云端不该知道文件名）的矛盾：
 * 两边的约束都不破，而且比任一份文档都更严 —— 连我们自己的访问日志里都没有它。
 */

export type ShareState = 'active' | 'expired' | 'revoked' | 'missing';

export interface ShareMeta {
  readonly id: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
  readonly hasPassword: boolean;
  readonly previewable: boolean;
}

export interface ShareView {
  readonly state: ShareState;
  readonly meta?: ShareMeta;
}

export function shareOrigin(): string {
  const fromEnv = import.meta.env.VITE_SHARE_ORIGIN;
  return (fromEnv && fromEnv.trim() !== '' ? fromEnv : '').replace(/\/$/, '');
}

/** `/s/<id>` 里的 id。取不到就是链接本身不对。 */
export function shareIdFromPath(pathname: string): string | undefined {
  const match = /^\/s\/([A-Za-z0-9_-]{1,64})$/.exec(pathname.replace(/\/+$/, ''));
  return match?.[1];
}

/**
 * 片段里的文件名。
 *
 * 取不到不是错误：链接经过某些聊天工具时 `#` 之后会被吃掉。
 * 那种情况下页面照常可用，只是名字显示成「未随链接传来」—— **不要因此拒绝下载**。
 */
export function fileNameFromHash(hash: string): string | undefined {
  const raw = hash.replace(/^#/, '');
  if (raw === '') return undefined;
  try {
    const decoded = decodeURIComponent(raw);
    // 名字是接收方那一侧唯一的不可信输入，先把路径分隔符与控制字符挡掉。
    // 用码点判断而不是正则：控制字符写进正则会被 lint 拦（而那条 lint 是对的 ——
    // 正则里的裸控制字符通常是手滑，这里是刻意的，所以换一种写法而不是关掉它）。
    if (decoded.includes('/') || decoded.includes('\\')) return undefined;
    if ([...decoded].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)) return undefined;
    return decoded.slice(0, 200);
  } catch {
    return undefined;
  }
}

export async function fetchShare(id: string): Promise<ShareView | undefined> {
  try {
    const res = await fetch(`${shareOrigin()}/v1/s/${id}`);
    if (!res.ok) return undefined;
    return (await res.json()) as ShareView;
  } catch {
    return undefined;
  }
}

/**
 * 明文密码**不离开这个浏览器**：这里算 `sha256(shareId:password)` 再发哈希，
 * 与上传侧只传哈希是同一条（`services/artifacts/src/upload.ts` 末尾）。
 */
export async function hashSharePassword(shareId: string, password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${shareId}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function unlock(id: string, password: string): Promise<string | undefined> {
  const passwordHash = await hashSharePassword(id, password);
  try {
    const res = await fetch(`${shareOrigin()}/v1/s/${id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passwordHash }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: boolean; grant?: string };
    return body.ok === true ? body.grant : undefined;
  } catch {
    return undefined;
  }
}

export function blobUrl(id: string): string {
  return `${shareOrigin()}/v1/s/${id}/blob`;
}

/**
 * 取字节。
 *
 * 走 fetch + object URL 而不是 `<a href>` 直下，是为了**让保存下来的文件有正确的名字**
 * 却又不把名字发给服务器 —— 服务器不知道它，`Content-Disposition` 里也就写不出来。
 */
export async function fetchBytes(id: string, grant?: string): Promise<Blob | undefined> {
  try {
    const res = await fetch(blobUrl(id), {
      headers: grant ? { 'x-evowork-grant': grant } : {},
    });
    if (!res.ok) return undefined;
    return await res.blob();
  } catch {
    return undefined;
  }
}

export function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

/** 剩余有效期。只给粗粒度 —— 接收方需要的是"还来不来得及下"，不是秒表。 */
export function formatRemaining(expiresAt: number, now = Date.now()): string {
  const ms = (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) - now;
  if (ms <= 0) return '已过期';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天后失效`;
  if (hours >= 1) return `${hours} 小时后失效`;
  return `${Math.max(1, Math.round(ms / 60_000))} 分钟后失效`;
}

const TYPE_LABELS: readonly (readonly [RegExp, string])[] = [
  [/wordprocessingml|msword/, 'Word 文档'],
  [/spreadsheetml|ms-excel/, 'Excel 表格'],
  [/presentationml|ms-powerpoint/, 'PowerPoint 演示'],
  [/^application\/pdf/, 'PDF'],
  [/^image\//, '图片'],
  [/^text\//, '文本'],
  [/zip/, '压缩包'],
];

export function typeLabel(contentType: string): string {
  for (const [pattern, label] of TYPE_LABELS) {
    if (pattern.test(contentType)) return label;
  }
  return '文件';
}

/** 猜一个扩展名，只在片段里没带文件名时用来兜底命名。 */
export function fallbackName(id: string, contentType: string): string {
  const ext = /wordprocessingml/.test(contentType)
    ? 'docx'
    : /spreadsheetml/.test(contentType)
      ? 'xlsx'
      : /presentationml/.test(contentType)
        ? 'pptx'
        : /^application\/pdf/.test(contentType)
          ? 'pdf'
          : /^image\/png/.test(contentType)
            ? 'png'
            : /^image\/jpe?g/.test(contentType)
              ? 'jpg'
              : 'bin';
  return `${id}.${ext}`;
}
