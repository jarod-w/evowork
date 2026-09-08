/**
 * `~/.evowork/app.toml` 与 D11 的机制化第①条：**`mode` 是权威，URL 反推退役**。
 *
 * 这组断言守的是一件很容易被"顺手改回去"的事：拓扑判断的方向。
 * 反推回来的表现是一个 401（下拉连不上，而真正的网关在别人的机器上），
 * 那是最难查的一种失败 —— 两处配置各自都是合法值，没有任何一层会报错。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_APP_CONFIG,
  parseAppConfig,
  readAppConfig,
  resolveAppConfig,
  serializeAppConfig,
} from '../src/main/app-config.js';
import { isLocalGateway } from '../src/main/gateway-process.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-appcfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('解析', () => {
  it('读 `[gateway]` 段的两个键', () => {
    const config = parseAppConfig(
      '[gateway]\nmode = "private"\nupstream_base_url = "https://gw.corp.example/v1"\n',
    );
    expect(config).toEqual({ mode: 'private', upstreamBaseUrl: 'https://gw.corp.example/v1' });
  });

  it('不认识的 mode 退到 `local` —— 手改坏的配置不该让应用打不开，而 local 是最保守那档', () => {
    expect(parseAppConfig('[gateway]\nmode = "cloudy"\n').mode).toBe('local');
    expect(parseAppConfig('').mode).toBe('local');
  });

  it('只认 `[gateway]` 段里的键 —— 别的段里同名键不算', () => {
    expect(parseAppConfig('[other]\nmode = "hosted"\n').mode).toBe('local');
  });

  it('写出来的能被自己读回去（改一处格式不会静默失效）', () => {
    const config = { mode: 'hosted' as const, upstreamBaseUrl: 'https://api.example/v1' };
    expect(parseAppConfig(serializeAppConfig(config))).toEqual(config);
  });
});

describe('D11：mode 是权威，URL 反推只发生一次', () => {
  it('`app.toml` 存在时**完全不看** kernel 的 base_url', () => {
    const path = join(dir, 'app.toml');
    writeFileSync(path, '[gateway]\nmode = "local"\n');
    const { config, inferred } = resolveAppConfig({
      path,
      // 一个远端地址：老逻辑会据此判成"网关在别处"
      kernelBaseUrl: 'https://gateway.example.com/v1',
      isLoopback: isLocalGateway,
    });
    expect(config.mode).toBe('local');
    expect(inferred).toBe(false);
  });

  it('全新机器（没有 app.toml、base_url 是 loopback）→ local，并写回文件', () => {
    const path = join(dir, 'app.toml');
    const { config, inferred } = resolveAppConfig({
      path,
      kernelBaseUrl: 'http://127.0.0.1:8787/v1',
      isLoopback: isLocalGateway,
    });
    expect(config).toEqual(DEFAULT_APP_CONFIG);
    expect(inferred).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  /*
   * 老装机：已经在用企业私有网关（`config.toml` 里是个远端地址），而 `app.toml` 还不存在。
   * 不做这次反推的话，升级后这台机器会突然变成 `local` —— 本机起一个拿不到任何厂商密钥
   * 的网关，而真正的网关在服务器上。用户看到"连不上网关"，然后去查一个根本不该存在的进程。
   */
  it('老装机（没有 app.toml、base_url 指向别处）→ 反推成 private 并写回，且只推这一次', () => {
    const path = join(dir, 'app.toml');
    const first = resolveAppConfig({
      path,
      kernelBaseUrl: 'https://gateway.corp.example/v1',
      isLoopback: isLocalGateway,
    });
    expect(first.config).toEqual({
      mode: 'private',
      upstreamBaseUrl: 'https://gateway.corp.example/v1',
    });
    // `inferred` 是给日志的：一次静默的拓扑推断在排查 401 时完全看不见
    expect(first.inferred).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('private');

    // 第二次：文件已经在了，**不再看 URL**（哪怕这次给一个 loopback）
    const second = resolveAppConfig({
      path,
      kernelBaseUrl: 'http://127.0.0.1:8787/v1',
      isLoopback: isLocalGateway,
    });
    expect(second.config.mode).toBe('private');
    expect(second.inferred).toBe(false);
  });

  it('写不进文件（只读目录）也不抛 —— 这一轮按推断值跑，下一轮再推一次', () => {
    const { config } = resolveAppConfig({
      path: join(dir, '不存在的子目录', 'app.toml'),
      kernelBaseUrl: 'http://localhost:8787/v1',
      isLoopback: isLocalGateway,
    });
    expect(config.mode).toBe('local');
  });

  it('读不到 / 读坏了返回 undefined，由 resolve 决定怎么办', () => {
    expect(readAppConfig(join(dir, '没有这个文件'))).toBeUndefined();
  });
});
