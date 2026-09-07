/**
 * 本机网关子进程（拓扑 A）。
 *
 * 这组断言守的是**"起不起"这个判断本身** —— 它做错的两种方式代价都不小：
 *   · 该起不起 → 用户看到"连不上网关"，而网关就在他机器上、只是没人拉起来
 *     （2026-09-06 真发生过：改了模型目录，界面还是旧列表，因为进程是几小时前起的）；
 *   · 不该起却起 → 企业部署的机器上多一个占着 8787、拿不到任何厂商 key 的进程，
 *     每次请求都失败，而用户会去查一个**根本不该存在**的东西。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { isLocalGateway, portOf, startLocalGateway } from '../src/main/gateway-process.js';

function fakeSpawn() {
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  const spawnFn = vi.fn(() => child);
  return { child, spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn };
}

function entry(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evowork-gw-'));
  const path = join(dir, 'main.js');
  writeFileSync(path, '');
  return path;
}

describe('起不起本机网关：判据是 base_url 指向哪儿', () => {
  it('环回地址的三种写法都算本机', () => {
    expect(isLocalGateway('http://127.0.0.1:8787/v1')).toBe(true);
    expect(isLocalGateway('http://localhost:8787/v1')).toBe(true);
    expect(isLocalGateway('http://[::1]:8787/v1')).toBe(true);
  });

  /*
   * `0.0.0.0` 是"监听所有网卡"的**服务端**写法。出现在 base_url 里意味着有人
   * 把服务端配置抄进了客户端配置 —— 此时起一个本机进程只会掩盖那个笔误。
   */
  it('0.0.0.0 不算本机 —— 它出现在这里本身就是个配置错误', () => {
    expect(isLocalGateway('http://0.0.0.0:8787/v1')).toBe(false);
  });

  it('远端地址不起进程，且**不给用户任何提示**（网关在服务器上是正常部署）', () => {
    const { spawnFn } = fakeSpawn();
    const gw = startLocalGateway({
      baseUrl: 'https://gateway.example.com/v1',
      entryPath: entry(),
      env: { DEEPSEEK_API_KEY: 'k' },
      spawnFn,
    });
    expect(gw.result).toEqual({ started: false, reason: 'REMOTE' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  /*
   * 网关自己会因为"一家密钥都没配"拒绝启动（`gateway.boot.no_models`）。
   * 让它起了再退的话，用户看到的是"连不上网关"，而真正的原因隔着一层。
   */
  it('一家密钥都没配时**不起**，并说清是密钥的问题', () => {
    const { spawnFn } = fakeSpawn();
    const gw = startLocalGateway({
      baseUrl: 'http://127.0.0.1:8787/v1',
      entryPath: entry(),
      env: {},
      spawnFn,
    });
    expect(gw.result.started).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
    // 收窄到"没起且有 notice"那一支：`REMOTE` 没有 notice（网关在别处是正常部署）
    if (gw.result.started || gw.result.reason === 'REMOTE') throw new Error('unreachable');
    expect(gw.result.reason).toBe('NO_KEYS');
    expect(gw.result.notice).toContain('密钥');
  });

  it('产物不在时说"安装包不完整"，不说"连不上"', () => {
    const { spawnFn } = fakeSpawn();
    const gw = startLocalGateway({
      baseUrl: 'http://127.0.0.1:8787/v1',
      entryPath: '/nope/main.js',
      env: { ZHIPU_API_KEY: 'k' },
      spawnFn,
    });
    if (gw.result.started || gw.result.reason === 'REMOTE') throw new Error('unreachable');
    expect(gw.result.reason).toBe('NO_ENTRY');
    expect(gw.result.notice).toContain('重新安装');
  });
});

describe('起起来之后的参数', () => {
  it('用 ELECTRON_RUN_AS_NODE 跑 —— **用户机器上没有 node**', () => {
    const { spawnFn } = fakeSpawn();
    const path = entry();
    startLocalGateway({
      baseUrl: 'http://127.0.0.1:9999/v1',
      entryPath: path,
      token: 'tok',
      env: { DEEPSEEK_API_KEY: 'k' },
      execPath: '/Applications/EvoWork.app/Contents/MacOS/EvoWork',
      spawnFn,
    });

    const call = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(call[0]).toBe('/Applications/EvoWork.app/Contents/MacOS/EvoWork');
    expect(call[1]).toEqual([path]);
    expect(call[2].env.ELECTRON_RUN_AS_NODE).toBe('1');
    // 端口跟着 base_url 走：两处各写一个默认值就会漂
    expect(call[2].env.PORT).toBe('9999');
    // **只监听环回**：本机网关不该被同网段的别人连上
    expect(call[2].env.HOST).toBe('127.0.0.1');
    // 内核与下拉用同一个令牌，网关这边就得认它
    expect(call[2].env.EVOWORK_GATEWAY_TOKENS).toBe('tok');
  });

  it('端口取自 base_url，缺省回落到 8787（与 config.toml.template 一致）', () => {
    expect(portOf('http://127.0.0.1:9001/v1')).toBe(9001);
    expect(portOf('http://127.0.0.1/v1')).toBe(8787);
    expect(portOf('这不是个地址')).toBe(8787);
  });

  /*
   * **`spawnFn` 必须有默认值。** 2026-09-06 实测踩到：宿主只在测试里传它，
   * 真跑时 `startLocalGateway` 走进"缺少启动器"分支，网关一次都没起来 ——
   * 而那句话看起来像配置问题，与"代码里少了个默认值"完全对不上。
   */
  it('不传 spawnFn 时用真的 spawn，而不是判定"缺少启动器"', () => {
    const gw = startLocalGateway({
      baseUrl: 'http://127.0.0.1:8787/v1',
      // 产物不存在 → 走 NO_ENTRY 分支，不会真起进程；这里验的是**没有 spawnFn 也能走到这一步**
      entryPath: '/nope/main.js',
      env: { DEEPSEEK_API_KEY: 'k' },
    });
    if (gw.result.started || gw.result.reason === 'REMOTE') throw new Error('unreachable');
    expect(gw.result.reason).toBe('NO_ENTRY');
    expect(gw.result.notice).not.toContain('缺少启动器');
  });

  it('stop() 杀掉子进程 —— 留着会占住端口，下次启动起不来', () => {
    const { child, spawnFn } = fakeSpawn();
    const gw = startLocalGateway({
      baseUrl: 'http://127.0.0.1:8787/v1',
      entryPath: entry(),
      env: { MOONSHOT_API_KEY: 'k' },
      spawnFn,
    });
    expect(gw.result.started).toBe(true);
    gw.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it('spawn 异步失败后不要假装已经起了 —— 否则 listModels 会写成「连不上」', () => {
    const { child, spawnFn } = fakeSpawn();
    const gw = startLocalGateway({
      baseUrl: 'http://127.0.0.1:8787/v1',
      entryPath: entry(),
      env: { DEEPSEEK_API_KEY: 'k' },
      spawnFn,
    });
    expect(gw.result.started).toBe(true);
    const error = child.on.mock.calls.find((c) => c[0] === 'error')?.[1] as
      | ((err: Error) => void)
      | undefined;
    expect(error).toBeTypeOf('function');
    error?.(new Error('spawn ENOENT'));
    expect(gw.result.started).toBe(false);
    if (gw.result.started || gw.result.reason === 'REMOTE') throw new Error('unreachable');
    expect(gw.result.reason).toBe('SPAWN_FAILED');
    expect(gw.result.notice).not.toContain('连不上');
  });
});
