// @vitest-environment node
/**
 * 在线升级的主进程一侧（在线升级提案 §4 B4 · 总纲 Q46）。真临时目录 + 真本机 HTTP 服务当更新源 + 真签名。
 *
 * **为什么切到 node 环境**：desktop 的测试默认跑在 jsdom 里，而 jsdom 换掉了全局的 AbortController。
 * Node 24 的 fetch 只认它自己的 AbortSignal，于是请求在发出去之前就被拒了
 * （`RequestInit: Expected signal … to be an instance of AbortSignal`）—— 表现成「连不上更新服务器」，
 * 看起来像网络问题。主进程本来就跑在 Node 里，测它就该用 node 环境。
 *
 * 断的是后果：「什么时候一个请求都不发」「请求里不带什么」「验不过签就停」「校验不过的文件不留在盘上」，
 * 不是某个函数被调用了几次。
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UpdateStatusView } from '../src/shared/ipc.js';
import * as updates from '../src/main/update-check.js';
import { whenMissedCopy } from '../src/main/service-host.js';
import { signatureNameFor, type UpdatePublicKey } from '../src/main/update-manifest.js';

/* ───────────────────────── 签名（与 scripts/update-signing.mjs 同一个格式） ───────────────────────── */

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub: UpdatePublicKey = { kid, role: 'daily', jwk: publicKey.export({ format: 'jwk' }) };
  const signFile = (bytes: Uint8Array) =>
    JSON.stringify({
      alg: 'ES256',
      kid,
      signature: sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString(
        'base64url',
      ),
    });
  return { pub, signFile };
}

const OURS = keyPair('evowork-update-1');
const PACKAGE = Buffer.from('这是 0.0.5 的 dmg（测试替身）'.repeat(2000));
const PACKAGE_NAME = 'EvoWork-0.0.5-mac-arm64-unsigned.dmg';

function manifestFor(
  version: string,
  pkg: Buffer = PACKAGE,
  notes = '- 修复插件页为空\n  - 办公扩展会提示需要更新',
): Buffer {
  return Buffer.from(
    `version: ${version}
files:
  - url: EvoWork-${version}-mac-arm64-unsigned.zip
    sha512: ${createHash('sha512').update('zip').digest('base64')}
    size: 3
  - url: EvoWork-${version}-mac-arm64-unsigned.dmg
    sha512: ${createHash('sha512').update(pkg).digest('base64')}
    size: ${String(pkg.length)}
path: EvoWork-${version}-mac-arm64-unsigned.zip
sha512: x
releaseDate: '2026-10-03T00:00:00.000Z'
releaseNotes: |-
  ${notes}
`,
  );
}

/* ───────────────────────── 假的更新服务器 ───────────────────────── */

let root: string;
let server: Server;
let origin: string;
let files: Map<string, Buffer>;
let requests: { url: string; headers: IncomingHttpHeaders }[];
/** 设了就在发完这么多字节之后挂住，模拟停滞 */
let stallAfter: number | undefined;
let slowChunks = false;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ew-update-'));
  files = new Map();
  requests = [];
  stallAfter = undefined;
  slowChunks = false;
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    const body = files.get(req.url ?? '');
    if (body === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (stallAfter !== undefined) {
      res.write(body.subarray(0, stallAfter)); // 然后什么都不发
      return;
    }
    if (slowChunks) {
      let offset = 0;
      const tick = setInterval(() => {
        if (res.destroyed) return clearInterval(tick);
        res.write(body.subarray(offset, offset + 1024));
        offset += 1024;
        if (offset >= body.length) {
          clearInterval(tick);
          res.end();
        }
      }, 20);
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

/** 线上发一版：清单 + 按内容命名的签名 + 安装包 */
function publishVersion(
  version: string,
  opts: { sign?: (bytes: Uint8Array) => string; pkg?: Buffer } = {},
) {
  const manifest = manifestFor(version, opts.pkg ?? PACKAGE);
  files.set('/latest/latest-mac.yml', manifest);
  files.set(
    `/latest/signatures/${signatureNameFor(manifest)}`,
    Buffer.from((opts.sign ?? OURS.signFile)(manifest)),
  );
  files.set(`/latest/EvoWork-${version}-mac-arm64-unsigned.dmg`, opts.pkg ?? PACKAGE);
  return manifest;
}

/* ───────────────────────── 端口 ───────────────────────── */

function makeHost(
  overrides: Omit<Partial<updates.UpdateHostPorts>, 'signedIn'> & { signedIn?: boolean } = {},
) {
  const emitted: UpdateStatusView[] = [];
  const opened: string[] = [];
  const events: string[] = [];
  let now = 1_800_000_000_000;
  const { signedIn = false, ...rest } = overrides;
  const ports: updates.UpdateHostPorts = {
    appVersion: '0.0.4',
    platform: 'darwin',
    arch: 'arm64',
    feed: { kind: 'on', baseUrl: `${origin}/latest` },
    keys: [OURS.pub],
    signedIn: () => signedIn,
    prefsPath: join(root, 'home', 'update.json'),
    downloadsDir: () => join(root, 'Downloads'),
    fetch: (url, init) => fetch(url, { signal: init.signal, headers: init.headers }),
    now: () => now,
    openPath: async (path) => {
      opened.push(path);
      events.push('open');
    },
    quit: () => events.push('quit'),
    emit: (view) => emitted.push(view),
    quitImpact: () => ({ runningTasks: [], upcoming: [], runtimeInstalling: false }),
    ...rest,
  };
  return {
    ports,
    runtime: updates.createUpdateRuntime(),
    emitted,
    opened,
    events,
    advance: (ms: number) => (now += ms),
  };
}

const downloads = () =>
  existsSync(join(root, 'Downloads')) ? readdirSync(join(root, 'Downloads')) : [];

/* ───────────────────────── 什么时候出网 ───────────────────────── */

describe('什么时候出网（Q46 · Q30）', () => {
  it('未登录、开关默认关：自动检查一个请求都不发；点「检查更新」算显式触发，可以发', async () => {
    publishVersion('0.0.5');
    const h = makeHost();
    expect(updates.updateStatusView(h.ports, h.runtime).autoCheck).toBe(false);
    await updates.checkForUpdate(h.ports, h.runtime, 'auto');
    expect(requests).toEqual([]);
    expect((await updates.checkForUpdate(h.ports, h.runtime, 'manual')).phase).toBe('available');
    expect(requests.map((r) => r.url)).toEqual([
      '/latest/latest-mac.yml',
      `/latest/signatures/${signatureNameFor(manifestFor('0.0.5'))}`,
    ]);
  });

  it('已登录默认开：每天最多自动检查一次，24 小时之后才再查', async () => {
    publishVersion('0.0.5');
    const h = makeHost({ signedIn: true });
    await updates.checkForUpdate(h.ports, h.runtime, 'auto');
    expect(requests.length).toBe(2);
    h.runtime.phase = 'idle';
    h.advance(23 * 60 * 60 * 1000);
    await updates.checkForUpdate(h.ports, h.runtime, 'auto');
    expect(requests.length).toBe(2);
    h.advance(2 * 60 * 60 * 1000);
    await updates.checkForUpdate(h.ports, h.runtime, 'auto');
    expect(requests.length).toBe(4);
  });

  it('已登录也能关（2026-10-03）：关掉之后自动检查一个请求都不发，未登录那个开关不受影响', async () => {
    publishVersion('0.0.5');
    const h = makeHost({ signedIn: true });
    expect(updates.setAutoCheck(h.ports, h.runtime, false).autoCheck).toBe(false);
    await updates.checkForUpdate(h.ports, h.runtime, 'auto');
    expect(requests).toEqual([]);
    expect(updates.readUpdatePrefs(h.ports)).toMatchObject({
      autoWhenSignedIn: false,
      autoWhenSignedOut: false,
    });
  });

  it('未登录打开开关之后，和已登录一样自动检查', async () => {
    publishVersion('0.0.5');
    const h = makeHost();
    updates.setAutoCheck(h.ports, h.runtime, true);
    await updates.checkForUpdate(h.ports, h.runtime, 'auto');
    expect(requests.length).toBe(2);
  });

  it('请求里不带账号令牌、设备 id、Cookie，也不带当前版本号：一次检查关联不到任何人', async () => {
    publishVersion('0.0.5');
    const h = makeHost({ signedIn: true });
    await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    await updates.downloadUpdate(h.ports, h.runtime);
    expect(requests.length).toBe(3);
    for (const { url, headers } of requests) {
      expect(url).not.toContain('0.0.4');
      expect(Object.keys(headers).filter((k) => /auth|cookie|device|token|x-/i.test(k))).toEqual(
        [],
      );
      expect(String(headers['user-agent'] ?? '')).not.toContain('0.0.4');
    }
  });

  it('EVOWORK_UPDATE_FEED=off：手动点也一个请求都不发，并说明是组织统一分发', async () => {
    publishVersion('0.0.5');
    const h = makeHost({ feed: updates.updateFeedFrom({ EVOWORK_UPDATE_FEED: 'off' }) });
    const view = await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    expect(view.availability).toBe('off');
    expect(requests).toEqual([]);
  });

  it('客户端一把公钥都没有（打包时漏了）：不检查，不发请求 —— 验不了的清单不该去拿', async () => {
    publishVersion('0.0.5');
    const h = makeHost({ keys: [] });
    expect((await updates.checkForUpdate(h.ports, h.runtime, 'manual')).availability).toBe(
      'no-keys',
    );
    expect(requests).toEqual([]);
  });

  it('EVOWORK_UPDATE_FEED 只认 https（本机回环放行 http 给开发与 E2E）；写错的当成配置错误', () => {
    expect(updates.updateFeedFrom({})).toEqual({
      kind: 'on',
      baseUrl: updates.DEFAULT_UPDATE_FEED,
    });
    expect(
      updates.updateFeedFrom({ EVOWORK_UPDATE_FEED: 'https://mirror.corp/evowork/latest/' }),
    ).toEqual({
      kind: 'on',
      baseUrl: 'https://mirror.corp/evowork/latest',
    });
    expect(updates.updateFeedFrom({ EVOWORK_UPDATE_FEED: 'http://mirror.corp/latest' }).kind).toBe(
      'invalid',
    );
    expect(updates.updateFeedFrom({ EVOWORK_UPDATE_FEED: 'http://127.0.0.1:9/latest' }).kind).toBe(
      'on',
    );
  });

  it('默认更新源就是 electron-builder 打进包里的那个地址 —— 两处写的是同一个，改一处另一处会红', () => {
    const yml = readFileSync(join(__dirname, '../../../build/electron-builder.yml'), 'utf8');
    const url = /publish:\n {2}provider: generic\n {2}url: (\S+)/.exec(yml)?.[1];
    expect(url?.replace('${channel}', 'latest')).toBe(updates.DEFAULT_UPDATE_FEED);
  });
});

/* ───────────────────────── 先验签，再相信清单 ───────────────────────── */

describe('先验签，再相信清单里的任何一个字', () => {
  it('签名对：给出版本、大小与更新说明（纯文本，每条一行），不自动下载（Q46-4）', async () => {
    publishVersion('0.0.5');
    const h = makeHost();
    const view = await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    expect(view).toMatchObject({
      phase: 'available',
      offer: {
        version: '0.0.5',
        sizeBytes: PACKAGE.length,
        notes: ['修复插件页为空', '办公扩展会提示需要更新'],
        fileName: PACKAGE_NAME,
      },
    });
    expect(requests.some((r) => r.url.endsWith('.dmg'))).toBe(false);
  });

  it('清单被改了（比如换成攻击者的安装包）：按内容命名的签名找不到，判签名失败，不往下走', async () => {
    publishVersion('0.0.5');
    const evil = manifestFor('0.0.5', Buffer.from('evil'));
    files.set('/latest/latest-mac.yml', evil);
    const h = makeHost();
    const view = await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    expect(view).toMatchObject({ phase: 'error', error: 'bad-signature' });
    expect(view.offer).toBeUndefined();
  });

  it('别人的 key 冒用我们的 kid：签名失败 —— 认得这个名字不等于放行', async () => {
    const impostor = keyPair('evowork-update-1');
    publishVersion('0.0.5', { sign: impostor.signFile });
    const h = makeHost();
    expect(await updates.checkForUpdate(h.ports, h.runtime, 'manual')).toMatchObject({
      error: 'bad-signature',
    });
  });

  it('线上的版本不比本机新（相同或更低）：已是最新 —— 客户端不降级', async () => {
    publishVersion('0.0.3');
    const h = makeHost();
    expect((await updates.checkForUpdate(h.ports, h.runtime, 'manual')).phase).toBe('latest');
    publishVersion('0.0.4');
    expect((await updates.checkForUpdate(h.ports, h.runtime, 'manual')).phase).toBe('latest');
  });

  it('服务器出错与连不上分开说：前者是服务器的事，后者先查自己的网络', async () => {
    const h = makeHost();
    expect(await updates.checkForUpdate(h.ports, h.runtime, 'manual')).toMatchObject({
      error: 'server',
    });
    const down = makeHost({ feed: { kind: 'on', baseUrl: 'http://127.0.0.1:9/latest' } });
    const view = await updates.checkForUpdate(down.ports, down.runtime, 'manual');
    expect(view).toMatchObject({ error: 'offline' });
    expect(view.message).toContain('127.0.0.1:9');
  });
});

/* ───────────────────────── 下载 ───────────────────────── */

describe('下载到「下载」文件夹，校验过才算好', () => {
  it('下完：文件在「下载」文件夹、内容一字不差、不留 .part；进度只增不减', async () => {
    publishVersion('0.0.5');
    const h = makeHost();
    await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    const view = await updates.downloadUpdate(h.ports, h.runtime);
    expect(view.phase).toBe('ready');
    expect(downloads()).toEqual([PACKAGE_NAME]);
    expect(readFileSync(join(root, 'Downloads', PACKAGE_NAME)).equals(PACKAGE)).toBe(true);
    const percents = h.emitted.filter((v) => v.phase === 'downloading').map((v) => v.percent ?? 0);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it('下来的包与清单不一致：删掉，盘上什么都不留，也不会被打开', async () => {
    publishVersion('0.0.5');
    files.set(
      `/latest/${PACKAGE_NAME}`,
      Buffer.concat([PACKAGE.subarray(0, -1), Buffer.from('!')]),
    );
    const h = makeHost();
    await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    expect(await updates.downloadUpdate(h.ports, h.runtime)).toMatchObject({
      phase: 'error',
      error: 'mismatch',
    });
    expect(downloads()).toEqual([]);
    expect((await updates.quitAndOpenInstaller(h.ports, h.runtime)).ok).toBe(false);
    expect(h.opened).toEqual([]);
  });

  it('停滞：收不到字节超过看门狗时间就停，给出能照做的话，半截文件删掉', async () => {
    publishVersion('0.0.5');
    const h = makeHost({ stallMs: 200 });
    await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    stallAfter = 1000;
    const view = await updates.downloadUpdate(h.ports, h.runtime);
    expect(view).toMatchObject({ phase: 'error', error: 'stall' });
    expect(view.message).toContain('60 秒');
    expect(downloads()).toEqual([]);
  });

  it('取消：回到「可以更新」，说明已取消，半截文件删掉', async () => {
    publishVersion('0.0.5');
    slowChunks = true;
    const h = makeHost();
    await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    const pending = updates.downloadUpdate(h.ports, h.runtime);
    await new Promise((r) => setTimeout(r, 150));
    updates.cancelUpdateDownload(h.runtime);
    expect(await pending).toMatchObject({ phase: 'available', cancelled: true });
    expect(downloads()).toEqual([]);
  });

  it('之前下好、还没装：再检查时直接就是「已下载」，不再下一遍', async () => {
    publishVersion('0.0.5');
    const first = makeHost();
    await updates.checkForUpdate(first.ports, first.runtime, 'manual');
    await updates.downloadUpdate(first.ports, first.runtime);
    requests = [];
    const later = makeHost();
    expect((await updates.checkForUpdate(later.ports, later.runtime, 'manual')).phase).toBe(
      'ready',
    );
    expect(requests.some((r) => r.url.endsWith('.dmg'))).toBe(false);
  });
});

/* ───────────────────────── 退出并打开 ───────────────────────── */

describe('退出并打开安装包', () => {
  it('先打开、再退出：顺序反过来，退出之后就没人去打开它了', async () => {
    publishVersion('0.0.5');
    const h = makeHost();
    await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    await updates.downloadUpdate(h.ports, h.runtime);
    expect((await updates.quitAndOpenInstaller(h.ports, h.runtime)).ok).toBe(true);
    expect(h.events).toEqual(['open', 'quit']);
    expect(h.opened).toEqual([join(root, 'Downloads', PACKAGE_NAME)]);
  });

  it('下好之后「下载」文件夹里的文件被换了：不打开、不退出，要求重新下载', async () => {
    publishVersion('0.0.5');
    const h = makeHost();
    await updates.checkForUpdate(h.ports, h.runtime, 'manual');
    await updates.downloadUpdate(h.ports, h.runtime);
    writeFileSync(join(root, 'Downloads', PACKAGE_NAME), Buffer.alloc(PACKAGE.length));
    const result = await updates.quitAndOpenInstaller(h.ports, h.runtime);
    expect(result.ok).toBe(false);
    expect(h.events).toEqual([]);
    expect(updates.updateStatusView(h.ports, h.runtime)).toMatchObject({
      phase: 'error',
      error: 'mismatch',
    });
  });
});

describe('定时任务错过一次之后会怎样：按它自己的补偿策略说，不一概说「跳过」', () => {
  it('三种策略三句话', () => {
    expect(whenMissedCopy({ misfirePolicy: 'DROP', catchupWindowMs: 3_600_000 })).toContain(
      '不会补跑',
    );
    expect(
      whenMissedCopy({ misfirePolicy: 'FIRE_ONCE_ON_WAKE', catchupWindowMs: 6 * 3_600_000 }),
    ).toContain('6 小时内重新打开会补跑一次');
    expect(whenMissedCopy({ misfirePolicy: 'FIRE_ALL', catchupWindowMs: 3_600_000 })).toContain(
      '都补跑',
    );
  });
});
