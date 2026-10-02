/**
 * 更新清单签名的**接缝**：发版机上签（`scripts/update-signing.mjs`），客户端验
 * （`apps/desktop/src/main/update-manifest.ts`）。在线升级提案 §4 B3。
 *
 * 两边各写各的，任何一边的格式改了另一边都不会报错 —— 表现是「每一份清单都验不过」，
 * 而用户看到的只是「检查更新失败」。所以这里用**真的签名函数**签、**真的验签函数**验
 * （CLAUDE.md §9.1：接缝上要有守卫）。
 *
 * 没有 Developer ID 之前，这是应用内下载的唯一真实性校验（下载的文件不带 quarantine 标记，
 * Gatekeeper 不看），所以「拒绝」那几条比「通过」那条更要紧。
 */
import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  signatureNameFor as clientSignatureName,
  verifyUpdateManifest,
} from '../../apps/desktop/src/main/update-manifest.ts';
import { generateSigningKey, signatureNameFor, signManifest } from '../update-signing.mjs';

const MANIFEST = `version: 0.0.5
files:
  - url: EvoWork-0.0.5-mac-arm64-unsigned.zip
    sha512: abc
path: EvoWork-0.0.5-mac-arm64-unsigned.zip
`;

const daily = generateSigningKey('evowork-update-1', 'daily');
const backup = generateSigningKey('evowork-update-backup-1', 'backup');
const KEYS = [daily.publicEntry, backup.publicEntry];

describe('发版机签 → 客户端验', () => {
  it('日常那把签的清单验得过，并说出是哪一把', () => {
    const sig = signManifest(MANIFEST, {
      privateKeyPem: daily.privateKeyPem,
      kid: 'evowork-update-1',
    });
    expect(verifyUpdateManifest(MANIFEST, sig, KEYS)).toEqual({
      ok: true,
      kid: 'evowork-update-1',
      role: 'daily',
    });
  });

  it('日常那把丢了之后，用离线备用那把签的同样验得过 —— 这正是内嵌两把公钥的理由', () => {
    const sig = signManifest(MANIFEST, {
      privateKeyPem: backup.privateKeyPem,
      kid: 'evowork-update-backup-1',
    });
    expect(verifyUpdateManifest(MANIFEST, sig, KEYS)).toMatchObject({ ok: true, role: 'backup' });
  });

  it('签的是原始字节：Buffer 和同内容的字符串验出来一样', () => {
    const sig = signManifest(Buffer.from(MANIFEST), {
      privateKeyPem: daily.privateKeyPem,
      kid: 'evowork-update-1',
    });
    expect(verifyUpdateManifest(Buffer.from(MANIFEST), sig, KEYS).ok).toBe(true);
    expect(verifyUpdateManifest(MANIFEST, sig, KEYS).ok).toBe(true);
  });
});

describe('签名文件按清单内容命名', () => {
  it('两边算出同一个文件名 —— 对不上的话，客户端去取一个不存在的签名，每次检查更新都失败', () => {
    expect(clientSignatureName(MANIFEST)).toBe(signatureNameFor(MANIFEST));
    expect(clientSignatureName(Buffer.from(MANIFEST))).toBe(
      signatureNameFor(Buffer.from(MANIFEST)),
    );
  });

  it('清单改一个字，文件名就变 —— 新旧两份签名可以同时在服务器上，上传之间没有验不过的窗口', () => {
    expect(signatureNameFor(MANIFEST)).not.toBe(signatureNameFor(`${MANIFEST}\n`));
  });
});

describe('客户端拒绝的每一种情况', () => {
  const good = signManifest(MANIFEST, {
    privateKeyPem: daily.privateKeyPem,
    kid: 'evowork-update-1',
  });

  it('清单被改了一个字（比如把 sha512 换成攻击者的包）：bad-signature', () => {
    const tampered = MANIFEST.replace('sha512: abc', 'sha512: abd');
    expect(verifyUpdateManifest(tampered, good, KEYS)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('别人的 key 冒用我们的 kid：bad-signature，不是「认得这个名字就放行」', () => {
    const impostor = generateSigningKey('evowork-update-1');
    const sig = signManifest(MANIFEST, {
      privateKeyPem: impostor.privateKeyPem,
      kid: 'evowork-update-1',
    });
    expect(verifyUpdateManifest(MANIFEST, sig, KEYS)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('不认识的 kid：unknown-key', () => {
    const other = generateSigningKey('someone-else');
    const sig = signManifest(MANIFEST, { privateKeyPem: other.privateKeyPem, kid: 'someone-else' });
    expect(verifyUpdateManifest(MANIFEST, sig, KEYS)).toEqual({ ok: false, reason: 'unknown-key' });
  });

  it('客户端一把公钥都没有（打包时漏了）：no-keys，什么清单都不放行', () => {
    expect(verifyUpdateManifest(MANIFEST, good, [])).toEqual({ ok: false, reason: 'no-keys' });
  });

  it('DER 编码的签名不认：两边编码不一致时要报格式错，而不是偶尔验过、偶尔验不过', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = sign('sha256', Buffer.from(MANIFEST), privateKey).toString('base64url');
    const sig = JSON.stringify({ alg: 'ES256', kid: 'evowork-update-1', signature: der });
    expect(verifyUpdateManifest(MANIFEST, sig, KEYS)).toEqual({
      ok: false,
      reason: 'malformed-signature',
    });
  });

  it('算法字段不是 ES256、或者 .sig 根本不是 JSON：malformed-signature', () => {
    const parsed = JSON.parse(good);
    expect(
      verifyUpdateManifest(MANIFEST, JSON.stringify({ ...parsed, alg: 'none' }), KEYS),
    ).toEqual({ ok: false, reason: 'malformed-signature' });
    expect(verifyUpdateManifest(MANIFEST, '<html>404</html>', KEYS)).toEqual({
      ok: false,
      reason: 'malformed-signature',
    });
  });
});
