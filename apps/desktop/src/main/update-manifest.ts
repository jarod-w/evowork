/**
 * 更新清单的验签（在线升级提案 §4 B3；总纲 Q46 与 D9 的 K6 登记「完整性」一行）。
 *
 * ## 为什么要自己签
 *
 * `latest-mac.yml` 里的 sha512 和安装包放在同一台服务器上：它只证明文件没传坏，
 * 证明不了文件是我们发的。没有 Developer ID 之前，系统签名也帮不上忙；而应用内下载的
 * 文件不带 quarantine 标记，Gatekeeper 根本不会去看它（提案 §7 实测）。
 * 所以**这里是唯一的真实性校验**，不是锦上添花：验不过就不往下走，没有「仍然下载」。
 *
 * ## 格式（与 `scripts/update-signing.mjs` 的 `signManifest` 逐字节对齐）
 *
 * 签名放在清单同目录的 `signatures/<清单原始字节的 sha256>.sig`（`signatureNameFor`）。
 * 按内容命名是为了上传顺序：同名覆盖时，两次上传之间拉到「新清单 + 旧签名」的客户端会验签失败，
 * CDN 缓存还会把这个窗口拉长；按内容命名后拿到哪份清单就取哪份签名，旧签名从不删除。内容是：
 *
 * ```json
 * { "alg": "ES256", "kid": "evowork-update-1", "signature": "<base64url，P1363 的 r||s，64 字节>" }
 * ```
 *
 * 签的是清单文件的**原始字节**，不是解析后再序列化的东西（同 `packages/account` 的策略包：
 * 两边各序列化一次会在键序或空格上分叉，表现是「刚签的清单自己验不过」）。
 * 两边对不对得上由 `scripts/test/update-signing.test.mjs` 守着 —— 它用真的签名脚本签、
 * 用这里的函数验。
 *
 * 只做验签，不出网、不解析 yml：先验过，再相信清单里的任何一个字。
 */
import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';

/** 客户端信任的一把公钥。`role` 区分日常与离线备用（B3：2026-10-02 定为两把） */
export interface UpdatePublicKey {
  readonly kid: string;
  readonly role: 'daily' | 'backup';
  readonly jwk: JsonWebKey;
}

export type UpdateManifestVerifyFailure =
  /** 客户端一把公钥都没有 —— 打包时漏了，不是网络问题 */
  | 'no-keys'
  /** `.sig` 不是我们认识的格式（不是 JSON、算法不对、长度不对） */
  | 'malformed-signature'
  /** 签名用的那把 key 我们不认识 */
  | 'unknown-key'
  /** 认识那把 key，但签名对不上：清单被改过，或者不是我们签的 */
  | 'bad-signature';

export type UpdateManifestVerifyResult =
  | { readonly ok: true; readonly kid: string; readonly role: UpdatePublicKey['role'] }
  | { readonly ok: false; readonly reason: UpdateManifestVerifyFailure };

/** 这份清单的签名文件名（相对清单所在目录的 `signatures/`）。与发版脚本的同名函数必须算出同一个 */
export function signatureNameFor(manifest: Uint8Array | string): string {
  const bytes = typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : manifest;
  return `${createHash('sha256').update(bytes).digest('hex')}.sig`;
}

/** ES256 的 P1363 签名固定 64 字节，base64url 不带填充是 86 个字符 */
const P1363_BASE64URL_LENGTH = 86;

export function verifyUpdateManifest(
  manifest: Uint8Array | string,
  signatureFile: string,
  keys: readonly UpdatePublicKey[],
): UpdateManifestVerifyResult {
  if (keys.length === 0) return { ok: false, reason: 'no-keys' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(signatureFile);
  } catch {
    return { ok: false, reason: 'malformed-signature' };
  }
  const envelope = parsed as { alg?: unknown; kid?: unknown; signature?: unknown };
  if (
    envelope.alg !== 'ES256' ||
    typeof envelope.kid !== 'string' ||
    typeof envelope.signature !== 'string' ||
    envelope.signature.length !== P1363_BASE64URL_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.signature)
  ) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const key = keys.find((candidate) => candidate.kid === envelope.kid);
  if (!key) return { ok: false, reason: 'unknown-key' };

  let valid = false;
  try {
    valid = verify(
      'sha256',
      typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : manifest,
      { key: createPublicKey({ key: key.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(envelope.signature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  return valid
    ? { ok: true, kid: key.kid, role: key.role }
    : { ok: false, reason: 'bad-signature' };
}

/* ───────────────────────────── 清单内容 ───────────────────────────── */

/** `latest-mac.yml` 里列出的一个文件 */
export interface UpdateManifestFile {
  readonly url: string;
  /** base64 */
  readonly sha512: string;
  readonly size: number;
}

export interface UpdateManifest {
  readonly version: string;
  readonly files: readonly UpdateManifestFile[];
  readonly path?: string | undefined;
  readonly releaseDate?: string | undefined;
  /** 每行一条，已去掉 `- ` / `* ` 前缀与空行。来自 `build/release-notes.md`，**纯文本** */
  readonly notes: readonly string[];
}

export type ParseManifestResult =
  | { readonly ok: true; readonly manifest: UpdateManifest }
  | { readonly ok: false; readonly reason: string };

/**
 * 解析 electron-builder 写的 `latest-*.yml`。**发布脚本也用这一份**（`scripts/publish-release.mjs`
 * 经 esbuild 现编它），所以「发得出去」和「客户端认得」是同一个判据。
 *
 * 只认 electron-builder 生成的那个形状，认不出的行直接报错：不引 YAML 库 —— 形状固定，
 * 而一个宽容的解析器会把写错的清单也放过去。**验签之后才调它**：签名保证这是我们发的，
 * 这里只保证它是我们以为的那个形状。
 *
 * `releaseNotes` 支持 electron-builder（js-yaml）会写出的四种写法：块（`|` `|-`）、折叠块（`>` `>-`）、
 * 单引号、双引号，以及不加引号的一行。
 */
export function parseUpdateManifest(text: string): ParseManifestResult {
  const lines = text.split(/\r?\n/);
  let version: string | undefined;
  let path: string | undefined;
  let releaseDate: string | undefined;
  let notesText: string | undefined;
  const files: { url: string; sha512?: string; size?: number }[] = [];
  let current: { url: string; sha512?: string; size?: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    let m: RegExpExecArray | null;
    if ((m = /^version: (.+)$/.exec(line))) version = unquote(m[1] ?? '');
    else if (line === 'files:') continue;
    else if ((m = /^ {2}- url: (.+)$/.exec(line)))
      files.push((current = { url: unquote(m[1] ?? '') }));
    else if ((m = /^ {4}sha512: (.+)$/.exec(line)) && current) current.sha512 = unquote(m[1] ?? '');
    else if ((m = /^ {4}size: (\d+)$/.exec(line)) && current) current.size = Number(m[1]);
    else if (/^ {4}(blockMapSize|isAdminRightsRequired): /.test(line)) continue;
    else if ((m = /^path: (.+)$/.exec(line))) path = unquote(m[1] ?? '');
    else if (/^sha512: /.test(line)) continue;
    else if ((m = /^releaseDate: (.+)$/.exec(line))) releaseDate = unquote(m[1] ?? '');
    else if ((m = /^releaseNotes: ?(.*)$/.exec(line))) {
      const head = (m[1] ?? '').trim();
      if (/^[|>][-+]?$/.test(head)) {
        const block: string[] = [];
        while (
          i + 1 < lines.length &&
          (/^ {2}/.test(lines[i + 1] ?? '') || (lines[i + 1] ?? '').trim() === '')
        ) {
          i += 1;
          block.push((lines[i] ?? '').replace(/^ {2}/, ''));
        }
        notesText = head.startsWith('>') ? foldBlock(block) : block.join('\n');
      } else notesText = unquote(head);
    } else return { ok: false, reason: `清单里有认不出的一行：${line.slice(0, 80)}` };
  }

  if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    return { ok: false, reason: '清单没有可用的版本号' };
  }
  if (files.length === 0 || files.some((f) => f.sha512 === undefined || f.size === undefined)) {
    return { ok: false, reason: '清单里的文件缺少 sha512 或大小' };
  }
  const notes = (notesText ?? '')
    .split('\n')
    .map((n) => n.trim().replace(/^[-*]\s+/, ''))
    .filter((n) => n !== '');
  return {
    ok: true,
    manifest: {
      version,
      files: files.map((f) => ({ url: f.url, sha512: f.sha512 ?? '', size: f.size ?? 0 })),
      ...(path !== undefined ? { path } : {}),
      ...(releaseDate !== undefined ? { releaseDate } : {}),
      notes,
    },
  };
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(v)) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** YAML 折叠块：相邻的非空行用空格接起来，空行变成换行 */
function foldBlock(block: readonly string[]): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  for (const line of block) {
    if (line.trim() === '') {
      if (paragraph.length > 0) out.push(paragraph.join(' '));
      paragraph = [];
    } else paragraph.push(line.trim());
  }
  if (paragraph.length > 0) out.push(paragraph.join(' '));
  return out.join('\n');
}

/** `x.y.z` 与 `x.y.z-pre`，按数字比（0.0.10 比 0.0.9 新）。预发布版排在同号正式版之前 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number(n)), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** 清单所在目录里，这个平台读哪个文件（electron-builder 的命名） */
export function manifestNameFor(platform: string): string {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'linux') return 'latest-linux.yml';
  return 'latest.yml';
}

/**
 * 这台机器该下哪个安装包。mac 下 dmg（用户要手动替换，dmg 是他们认得的形状），
 * 清单里有多个架构时取名字里带本机架构的那个。没有合适的就返回 undefined，**不猜**。
 */
export function pickPackageFor(
  manifest: UpdateManifest,
  platform: string,
  arch: string,
): UpdateManifestFile | undefined {
  const ext = platform === 'darwin' ? '.dmg' : platform === 'linux' ? '.AppImage' : '.exe';
  const candidates = manifest.files.filter((f) => f.url.endsWith(ext));
  if (candidates.length <= 1) return candidates[0];
  return candidates.find((f) => f.url.includes(arch));
}
