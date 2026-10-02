#!/usr/bin/env node
/**
 * 打一份**插件 Hub 的企业离线包**（13 §4.7 ③，HUB-Q11=A）。照搬 `build-office-bundle.mjs` 的思路。
 *
 * ```bash
 * # 在有网的机器上
 * node scripts/build-hub-bundle.mjs --origin https://hub.example --out ./evowork-hub-bundle
 * # 只要白名单里的条目（企业自己筛官方内容，不需要管理界面）
 * node scripts/build-hub-bundle.mjs --origin https://hub.example --out ./b --allowlist ./allow.json
 * ```
 *
 * 产出的目录直接交给 `EVOWORK_HUB_BUNDLE`：
 *
 * ```
 * <out>/index.json                      我们签的**离线索引**原件（不重签、不改一个字节）
 * <out>/pkgs/<kind>/<id>/<ver>.tar.gz   选中条目的内容包（逐个按索引里的 sha256 校验过）
 * <out>/allowlist.json                  给了 --allowlist 时原样拷进来
 * <out>/MANIFEST.json                   打包时间、来源、序号、收了哪些、跳过了哪些
 * ```
 *
 * ## 为什么取 `index.offline.json` 而不是 `index.json`
 *
 * 在线索引的有效期很短（防「冻结一份旧索引不放新的过来」，4.5）；照搬到离线环境，
 * 企业就得每周导一次。所以官方源另外发一份**单独签名、有效期较长（建议 180 天）**的离线索引。
 * 代价是吊销要等企业导入新包才生效（13 §14）—— MANIFEST 里写明打包时间，插件页照着显示。
 * 源上没有离线索引时退回在线索引，**并大声说**：那份包几天后就会过期、不能新装。
 *
 * ## 这个脚本**不验签名**
 *
 * 钉死的公钥在 App 里（`apps/desktop/src/main/hub-config.ts`），验签发生在用户机器上读包的时候 ——
 * 这里改了索引，用户那边照样装不上。脚本只核对内容包的 sha256，让坏包在打包的人这边就失败，
 * 而不是在用户那边。
 *
 * ## 没写许可的条目不进离线包
 *
 * 那类条目我们**只做索引、不托管**（HUB-Q5a=A），内容在上游代码托管站。把它们下载进离线包
 * 再在企业内网分发，就是我们替人做了再分发。所以跳过，并写进 MANIFEST 的 `skipped`。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ID = 'evowork';
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

export async function buildHubBundle({
  origin,
  out,
  allowlistPath,
  sourceId = SOURCE_ID,
  fetchFn = fetch,
  now = () => Math.floor(Date.now() / 1000),
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const base = `${origin.replace(/\/+$/, '')}/v1/${encodeURIComponent(sourceId)}`;
  let indexText = await getText(fetchFn, `${base}/index.offline.json`);
  let offline = true;
  if (indexText === undefined) {
    offline = false;
    log(
      '⚠ 源上没有离线索引（index.offline.json），退回在线索引：它的有效期很短，这份离线包几天后就会过期、不能新装。',
    );
    indexText = await getText(fetchFn, `${base}/index.json`);
    if (indexText === undefined) throw new Error(`取不到索引：${base}/index.json`);
  }
  const envelope = JSON.parse(indexText);
  if (typeof envelope?.payloadJson !== 'string') throw new Error('索引不是签名信封');
  const payload = JSON.parse(envelope.payloadJson);
  if (payload?.source?.id !== sourceId) throw new Error(`索引的来源不是 ${sourceId}`);

  let allow;
  if (allowlistPath !== undefined) {
    const raw = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    if (!Array.isArray(raw.items)) throw new Error('白名单格式：{ "items": ["skill:<id>", ...] }');
    allow = new Set(raw.items);
  }

  mkdirSync(out, { recursive: true });
  const included = [];
  const skipped = [];
  for (const item of payload.items ?? []) {
    const key = `${item.kind}:${item.id}`;
    if (allow !== undefined && !allow.has(key)) continue;
    const revoked = (payload.revoked ?? []).some((r) => r.id === item.id);
    if (revoked) {
      skipped.push({ key, reason: '索引里有它的吊销记录' });
      continue;
    }
    if (item.package?.url !== undefined) {
      skipped.push({ key, reason: '没写许可的条目只做索引，内容不进离线包（HUB-Q5a=A）' });
      continue;
    }
    const path = item.package?.path;
    if (typeof path !== 'string' || path.split('/').some((seg) => seg === '..' || seg === '')) {
      throw new Error(`${key} 的内容包路径不对：${String(path)}`);
    }
    const bytes = await getBytes(fetchFn, `${base}/${path}`);
    if (bytes === undefined) throw new Error(`取不到 ${key} 的内容包：${path}`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== item.package.size || sha !== item.package.sha256) {
      throw new Error(`${key} 的内容包与索引登记的不一致（sha256 / 大小）`);
    }
    const dest = join(out, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    included.push({ key, version: item.version });
    log(`  ✓ ${key}@${item.version}`);
  }
  // 原件，一个字节都不改：用户机器上要对这段原文验签
  writeFileSync(join(out, 'index.json'), indexText);
  if (allowlistPath !== undefined) copyFileSync(allowlistPath, join(out, 'allowlist.json'));
  const manifest = {
    builtAt: now(),
    sourceId,
    sequence: payload.sequence,
    expiresAt: payload.expiresAt,
    offlineIndex: offline,
    included,
    skipped,
  };
  writeFileSync(join(out, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const s of skipped) log(`  – 跳过 ${s.key}：${s.reason}`);
  log(
    `▸ 完成：${out}（${included.length} 项，跳过 ${skipped.length} 项）。交给 EVOWORK_HUB_BUNDLE 使用。`,
  );
  return manifest;
}

async function getText(fetchFn, url) {
  const bytes = await getBytes(fetchFn, url);
  return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
}

async function getBytes(fetchFn, url) {
  const response = await fetchFn(url, { redirect: 'error' });
  if (response.status === 404) return undefined;
  if (response.status !== 200) throw new Error(`${url} 返回了 ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error(`${url} 太大了`);
  return bytes;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--origin') args.origin = argv[++i];
    else if (key === '--out') args.out = argv[++i];
    else if (key === '--allowlist') args.allowlistPath = argv[++i];
    else throw new Error(`不认识的参数：${key}`);
  }
  if (!args.origin || !args.out) {
    throw new Error(
      '用法：node scripts/build-hub-bundle.mjs --origin <https://…> --out <目录> [--allowlist <文件>]',
    );
  }
  return { ...args, out: resolve(args.out) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (existsSync(join(args.out, 'MANIFEST.json'))) {
      process.stdout.write(`（覆盖已有的离线包：${args.out}）\n`);
    }
    await buildHubBundle(args);
  } catch (error) {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
