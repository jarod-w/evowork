/**
 * 分享托管"起不起、绑在哪"。
 *
 * 这两条判断都在 2026-09-27 部署时出过事，而且都是**看起来一切正常**的那种：
 *   · 公钥被 systemd 吃坏了，进程照常起来，所有上传静默 401；
 *   · `listen(port)` 不给地址，服务直接听在公网网卡上，要靠 systemd 的
 *     `IPAddressAllow` 才挡下来。
 * `createShareServer` 的单测碰不到这里 —— 它们接收的是已经解析好的参数。
 */
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ACCESS_TTL_SEC, generateEs256KeyPair, signAccessToken } from '@evowork/account';
import { createLogger, memorySink } from '@evowork/logging';

import { start, type ShareProcess } from '../src/start.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 与线上一样：systemd 的 EnvironmentFile 里公钥是用字面量 `\n` 连成的一行 */
function oneLine(pem: string): string {
  return pem.trim().split('\n').join('\\n');
}

/** 2026-09-27 线上进程实际拿到的那一串：反斜杠被 systemd 当转义吃掉了 */
function mangledBySystemd(pem: string): string {
  return pem.trim().split('\n').join('n');
}

function env(over: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    EVOWORK_SHARE_PORT: '0',
    EVOWORK_SHARE_DIR: mkdtempSync(join(tmpdir(), 'evowork-share-')),
    ...over,
  };
}

/** 与 `main.ts` 同一个配置：`drop` —— 用 `throw` 的话测的就不是线上那条路径了 */
function logger() {
  const sink = memorySink();
  return { sink, log: createLogger({ service: 'share', onViolation: 'drop', sink }) };
}

const running: ShareProcess[] = [];
afterEach(() => {
  for (const p of running.splice(0)) p.stop();
});

async function listening(p: ShareProcess): Promise<AddressInfo> {
  running.push(p);
  if (!p.server.listening) await once(p.server, 'listening');
  return p.server.address() as AddressInfo;
}

describe('公钥体检：在、但用不了，就不启动', () => {
  it('单行公钥能起，而且真的验得过我们签的令牌（正向对照）', async () => {
    const pair = generateEs256KeyPair();
    const { log } = logger();
    const p = start(env({ EVOWORK_IDENTITY_PUBLIC_PEM: oneLine(pair.publicPem) }), log);
    expect(p).toBeDefined();
    const { port } = await listening(p!);

    const now = Math.floor(Date.now() / 1000);
    const token = signAccessToken(
      pair.privatePem,
      {
        sub: 'usr_1',
        tenant: 'ten_1',
        iat: now,
        exp: now + ACCESS_TTL_SEC,
        scope: 'gateway',
        quotaClass: 'default',
        deviceId: 'dev_1',
        role: 'member',
      },
      pair.kid,
    );
    // 令牌验过了才会走到"分享头不完整"；公钥用不了的话这里是 401
    const res = await fetch(`http://127.0.0.1:${port}/v1/shares`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it.each([
    [
      '被 systemd 吃掉反斜杠的那一串',
      () => mangledBySystemd(generateEs256KeyPair().publicPem),
      'unparseable',
    ],
    [
      '私钥（签发密钥不该出现在只验签的机器上）',
      () => oneLine(generateEs256KeyPair().privatePem),
      'private-key',
    ],
    [
      'RSA 公钥',
      () =>
        oneLine(
          generateKeyPairSync('rsa', { modulusLength: 2048 })
            .publicKey.export({ type: 'spki', format: 'pem' })
            .toString(),
        ),
      'not-es256',
    ],
  ])('%s：不起服务，日志里写清原因', (_, pem, reason) => {
    const { sink, log } = logger();
    const p = start(env({ EVOWORK_IDENTITY_PUBLIC_PEM: pem() }), log);

    expect(p).toBeUndefined();
    const boot = sink.records.find((r) => r.event === 'share.boot.bad_public_key');
    expect(boot?.fields.reason).toBe(reason);
    expect(sink.records.some((r) => r.event === 'share.listening')).toBe(false);
  });

  it('没给公钥：不起服务 —— 不降级成"不鉴权"', () => {
    const { sink, log } = logger();
    expect(start(env({}), log)).toBeUndefined();
    const boot = sink.records.find((r) => r.event === 'share.boot.no_public_key');
    expect(boot?.fields.reason).toBe('NO_PUBLIC_KEY');
  });
});

describe('绑在哪块网卡上', () => {
  const pem = () => oneLine(generateEs256KeyPair().publicPem);

  it('默认只听环回 —— 前面该有一层反代，不该直接挂在公网网卡上', async () => {
    const { log } = logger();
    const { address } = await listening(start(env({ EVOWORK_IDENTITY_PUBLIC_PEM: pem() }), log)!);
    expect(address).toBe('127.0.0.1');
  });

  /*
   * 证明 `EVOWORK_SHARE_HOST` 真的被用上了，但**不去绑一个非环回地址**：那样会在开了
   * 防火墙的 Mac 上弹授权框，而且连不连得上还受防火墙左右。改用一个不属于本机的
   * 文档保留地址（RFC 5737）—— 用上了就一定 EADDRNOTAVAIL，没用上就会在环回上起来。
   */
  it('EVOWORK_SHARE_HOST 被用上了（绑一个不属于本机的地址 → 必然失败）', async () => {
    const { log } = logger();
    const p = start(
      env({ EVOWORK_IDENTITY_PUBLIC_PEM: pem(), EVOWORK_SHARE_HOST: '203.0.113.1' }),
      log,
    )!;
    running.push(p);
    const [err] = (await once(p.server, 'error')) as [NodeJS.ErrnoException];
    expect(err.code).toBe('EADDRNOTAVAIL');
  });
});

/*
 * 进程内的 `start()` 测不到最后一段接缝：`main.ts` 有没有把"体检不过"变成非 0 退出码。
 * 退出码是 systemd 的 `Restart=on-failure` 与监控认的东西 —— 0 会被当成正常结束。
 * 所以把入口按部署时的方式打成单文件，真起一个进程看。
 */
describe('进程入口（按部署方式打包后真起）', () => {
  let bundle: string | undefined;
  function entry(): string {
    if (bundle) return bundle;
    const out = join(mkdtempSync(join(tmpdir(), 'evowork-share-entry-')), 'main.mjs');
    execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
      join(ROOT, 'services/share/src/main.ts'),
      '--bundle',
      `--outfile=${out}`,
      '--platform=node',
      '--format=esm',
      '--target=node22',
      '--log-level=warning',
    ]);
    bundle = out;
    return out;
  }

  function run(over: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, [entry()], {
      env: { PATH: process.env.PATH, ...env(over) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    return { child, stdout: () => stdout };
  }

  it('体检不过：以退出码 1 结束，且从没开始监听', async () => {
    const { child, stdout } = run({
      EVOWORK_IDENTITY_PUBLIC_PEM: mangledBySystemd(generateEs256KeyPair().publicPem),
    });
    // 它要是带着坏公钥起来了，就不会自己退出 —— 看到监听就立刻判错，别干等到超时
    const code = await new Promise<number | null>((done, fail) => {
      child.stdout.on('data', () => {
        if (stdout().includes('share.listening')) {
          child.kill();
          fail(new Error(`带着用不了的公钥开始监听了：\n${stdout()}`));
        }
      });
      child.once('exit', done);
    });

    expect(code).toBe(1);
    expect(stdout()).toContain('share.boot.bad_public_key');
  }, 30_000);

  // 正向对照：同一个打包产物、同一套观察手段，公钥好的时候确实能看到它起来 ——
  // 否则上一条的"退出码 1"也可能只是"这个产物怎么都起不来"
  it('公钥好：进程起来并开始监听', async () => {
    const { child, stdout } = run({
      EVOWORK_IDENTITY_PUBLIC_PEM: oneLine(generateEs256KeyPair().publicPem),
    });
    try {
      await new Promise<void>((done, fail) => {
        child.stdout.on('data', () => {
          if (stdout().includes('share.listening')) done();
        });
        child.once('exit', (code) => fail(new Error(`进程提前退出：${code}\n${stdout()}`)));
      });
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
    }
  }, 30_000);
});
