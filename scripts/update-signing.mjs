#!/usr/bin/env node
/**
 * 更新清单的签名：生成密钥 · 给清单签名（在线升级提案 §4 B3）。
 *
 *   node scripts/update-signing.mjs keygen --kid evowork-update-1 [--role daily]
 *   node scripts/update-signing.mjs keygen --kid evowork-update-backup-1 --role backup --out <离线位置>/backup.pem
 *   node scripts/update-signing.mjs sign dist/release/latest-mac.yml --kid evowork-update-1 [--key-file <pem>]
 *
 * 签名文件**按清单内容的 sha256 命名**：`<清单所在目录>/signatures/<sha256>.sig`。
 * 不叫 `latest-mac.yml.sig` 是因为上传有先后：清单与签名同名覆盖时，两次上传之间
 * 拉到「新清单 + 旧签名」（或反过来）的客户端会验签失败，CDN 缓存还会把这个窗口拉长。
 * 按内容命名之后，客户端拿到哪份清单就去取哪份签名，旧签名从不删除，没有窗口。
 *
 * 验签在客户端 `apps/desktop/src/main/update-manifest.ts`；两边的格式由
 * `scripts/test/update-signing.test.mjs` 用「这里签、那边验」守着。格式说明见那个文件的头注释。
 *
 * ## 私钥放哪（2026-10-02 定：只在发版机，不进 CI）
 *
 * 默认存进 macOS **登录钥匙串**（通用密码，service = `evowork-update-signing`，account = kid），
 * 不落成明文文件。`--out` / `--key-file` 用一个权限 0600 的 PEM 文件代替 —— 给离线备用那把
 * （它本来就该离开这台电脑）和测试用。
 *
 * **两处都不覆盖已有的 key**：签名私钥被悄悄换掉，客户端就再也验不过新清单，
 * 而那时谁也说不清旧私钥去哪了。
 */
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SIGNATURE_ALG = 'ES256';
export const KEYCHAIN_SERVICE = 'evowork-update-signing';

/** 签名文件名：清单原始字节的 sha256（十六进制）。客户端那边的 `signatureNameFor` 必须算出同一个 */
export function signatureNameFor(manifest) {
  const bytes = typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : manifest;
  return `${createHash('sha256').update(bytes).digest('hex')}.sig`;
}

/** P-256 一对新 key。`publicEntry` 就是要贴进 `update-keys.ts` 的那一项 */
export function generateSigningKey(kid, role = 'daily') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicEntry: { kid, role, jwk: { kty, crv, x, y } },
  };
}

/**
 * 给清单的**原始字节**签名，返回 `.sig` 文件的内容。
 * 签完立刻用同一把 key 的公钥验一遍：签出一个自己都验不过的文件，比不签更糟。
 */
export function signManifest(manifest, { privateKeyPem, kid }) {
  const bytes = typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : manifest;
  const key = createPrivateKey(privateKeyPem);
  const signature = sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' });
  const ok = verify(
    'sha256',
    bytes,
    { key: createPublicKey(key), dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!ok) throw new Error('签完自验失败：这把私钥有问题，不要发布');
  return `${JSON.stringify(
    { alg: SIGNATURE_ALG, kid, signature: signature.toString('base64url') },
    null,
    2,
  )}\n`;
}

/* ───────────────────────────── 钥匙串 ───────────────────────────── */

function keychainHas(kid) {
  try {
    execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', kid], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * PEM 是多行的；钥匙串的 `-w` 遇到控制字符会改成十六进制输出，所以存 base64。
 * 值经 argv 交给 `security`，进程存活的那几毫秒里 `ps` 看得见 —— 在一台单人使用的发版机上
 * 可以接受；`security` 没有从 stdin 读密码的选项，`-w` 不带值又只能在终端里手输。
 */
function keychainStore(kid, pem) {
  execFileSync('security', [
    'add-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    kid,
    '-D',
    'EvoWork update signing key',
    '-w',
    Buffer.from(pem, 'utf8').toString('base64'),
  ]);
}

function keychainRead(kid) {
  const b64 = execFileSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', kid, '-w'],
    { encoding: 'utf8' },
  ).trim();
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** 签名私钥：给了 `keyFile` 就读文件，否则从 macOS 登录钥匙串取（`keygen` 存进去的那一项） */
export function readPrivateKey({ kid, keyFile }) {
  return keyFile ? readFileSync(keyFile, 'utf8') : keychainRead(kid);
}

/* ───────────────────────────── CLI ───────────────────────────── */

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(argv) {
  const [command, ...args] = argv;
  const kid = option(args, '--kid');
  if (!kid || !/^[A-Za-z0-9._-]+$/.test(kid)) {
    throw new Error('需要 --kid（只能用字母、数字、点、下划线、连字符）');
  }

  if (command === 'keygen') {
    const role = option(args, '--role') ?? 'daily';
    if (role !== 'daily' && role !== 'backup') throw new Error('--role 只能是 daily 或 backup');
    const out = option(args, '--out');
    const { privateKeyPem, publicEntry } = generateSigningKey(kid, role);
    if (out) {
      // flag wx：文件已在就失败，不覆盖
      writeFileSync(out, privateKeyPem, { mode: 0o600, flag: 'wx' });
      console.error(`私钥写到了 ${out}（0600）。它是离线备用那把的话，现在就把它挪离这台电脑。`);
    } else {
      if (process.platform !== 'darwin') throw new Error('不是 macOS：请用 --out 指定私钥文件');
      if (keychainHas(kid)) throw new Error(`钥匙串里已经有 ${kid}，不覆盖。换一个 kid`);
      keychainStore(kid, privateKeyPem);
      console.error(`私钥存进了登录钥匙串（service=${KEYCHAIN_SERVICE}, account=${kid}）。`);
    }
    console.error('把下面这一项贴进 apps/desktop/src/main/update-keys.ts 的 UPDATE_PUBLIC_KEYS：');
    console.log(JSON.stringify(publicEntry, null, 2));
    return;
  }

  if (command === 'sign') {
    const manifestPath = args[0];
    if (!manifestPath || manifestPath.startsWith('--'))
      throw new Error('用法：sign <清单路径> --kid <kid>');
    const keyFile = option(args, '--key-file');
    const privateKeyPem = readPrivateKey({ kid, keyFile });
    const manifest = readFileSync(manifestPath);
    const dir = join(dirname(manifestPath), 'signatures');
    mkdirSync(dir, { recursive: true });
    const sigPath = join(dir, signatureNameFor(manifest));
    writeFileSync(sigPath, signManifest(manifest, { privateKeyPem, kid }));
    console.log(`✅ 已签名：${sigPath}（kid=${kid}）`);
    return;
  }

  throw new Error('用法：update-signing.mjs keygen|sign …（见文件头）');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
