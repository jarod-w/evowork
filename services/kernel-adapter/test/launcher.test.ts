/**
 * 真实 launcher（`createSpawnLauncher`）。
 *
 * 它承担的是**"内核长什么样"这部分知识**：可执行文件、环境变量、stdio 帧、stderr 怎么处理。
 * 这些原先散在桌面壳里，被 `@evowork/no-kernel-internals` 纠正过来（见 launcher.ts 的头注释）。
 */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createSpawnLauncher, withLoopbackNoProxy } from '../src/launcher.js';
import type { KernelProcess } from '../src/session.js';

/** spawn 的调用记录：只关心可执行文件与 options.env */
type SpawnCall = [string, readonly string[], { env: Record<string, string> }];

function spawnSpy(child: unknown) {
  return vi.fn((..._args: unknown[]) => child) as unknown as ReturnType<typeof vi.fn> & {
    mock: { calls: SpawnCall[] };
  };
}

/** `KernelLauncher.launch()` 允许返回 Promise（远端内核会用到）；本 launcher 是同步的 */
function launchSync(launcher: ReturnType<typeof createSpawnLauncher>): KernelProcess {
  return launcher.launch() as KernelProcess;
}

function fakeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => undefined;
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
    resume: () => void;
  };
  stderr.setEncoding = () => undefined;
  stderr.resume = vi.fn();
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe('createSpawnLauncher', () => {
  it.runIf(process.platform === 'win32')(
    '停止真实自有内核进程时，其连接器子进程也必须退出且重复停止安全',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'evowork-kernel-stop-'));
      const cleanupHome = resolve(home);
      if (dirname(cleanupHome) !== resolve(tmpdir())) throw new Error('Unexpected test directory');
      mkdirSync(join(home, 'startup'));
      const powershell = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const program =
        "$info = New-Object System.Diagnostics.ProcessStartInfo; $info.FileName = [System.IO.Path]::Combine($PSHOME, 'powershell.exe'); $info.Arguments = '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 300'; $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $started = [System.Diagnostics.Process]::Start($info); @{parentPid=$PID;childPid=$started.Id} | ConvertTo-Json -Compress; Start-Sleep -Seconds 300";
      let child: ChildProcess | undefined;
      let closed: Promise<void> | undefined;
      let identity: { parentPid: number; childPid: number } | undefined;
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      };
      try {
        const proc = launchSync(
          createSpawnLauncher({
            appServerPath: powershell,
            kernelHome: home,
            spawnFn: ((_file, _args, options) => {
              child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', program], {
                ...options,
                windowsHide: true,
              });
              closed = new Promise<void>((done) => child!.once('close', () => done()));
              return child;
            }) as typeof spawn,
          }),
        );
        let output = '';
        proc.onStdout((chunk) => {
          output += chunk;
          if (output.includes('\n')) identity = JSON.parse(output.split('\n')[0]!);
        });
        await expect.poll(() => identity, { timeout: 5000 }).toBeDefined();
        expect(identity!.parentPid).toBe(child!.pid);
        expect(alive(identity!.childPid)).toBe(true);
        proc.kill();
        await expect.poll(() => alive(identity!.parentPid), { timeout: 2000 }).toBe(false);
        await expect.poll(() => alive(identity!.childPid), { timeout: 2000 }).toBe(false);
        proc.kill();
      } finally {
        if (identity?.childPid && alive(identity.childPid))
          process.kill(identity.childPid, 'SIGKILL');
        if (child?.pid && alive(child.pid)) child.kill('SIGKILL');
        await closed;
        if (identity?.childPid)
          await expect.poll(() => alive(identity!.childPid), { timeout: 2000 }).toBe(false);
        rmSync(cleanupHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    20000,
  );
  it('把 CODEX_HOME 指向我们的目录，但**保留内核原本的变量名**（K5）', () => {
    const child = fakeChild();
    const spawnFn = spawnSpy(child);
    launchSync(
      createSpawnLauncher({
        appServerPath: '/opt/evowork/codex-app-server',
        kernelHome: '/home/u/.evowork/kernel',
        spawnFn: spawnFn as never,
      }),
    );

    expect(spawnFn.mock.calls[0]?.[0]).toBe('/opt/evowork/codex-app-server');
    const env = spawnFn.mock.calls[0]![2].env;
    expect(env.CODEX_HOME).toBe('/home/u/.evowork/kernel');
    // 继承宿主环境（PATH 等），否则内核找不到它要调的工具
    expect(env.PATH).toBeDefined();
  });

  it('**发往本机网关的流量不走系统代理**：回环一定在 NO_PROXY 里（2026-09-28 实测）', () => {
    /*
     * 开着 Clash 一类代理时，内核发往 127.0.0.1 网关的请求（整段 prompt）曾全部绕进
     * 127.0.0.1:7890；代理一抖，内核收到没有正文的 502，回合失败。
     */
    const child = fakeChild();
    const spawnFn = spawnSpy(child);
    launchSync(
      createSpawnLauncher({
        appServerPath: '/opt/evowork/codex-app-server',
        kernelHome: '/home/u/.evowork/kernel',
        // 企业的额外环境里即便写了别的 NO_PROXY，也不能把回环挤掉
        extraEnv: { NO_PROXY: 'intranet.example' },
        spawnFn: spawnFn as never,
      }),
    );
    const env = spawnFn.mock.calls[0]![2].env;
    for (const key of ['NO_PROXY', 'no_proxy'] as const) {
      const entries = env[key]!.split(',');
      expect(entries).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', '::1']));
      // 用户 / 企业原有的例外保留
      expect(entries).toContain('intranet.example');
    }
  });

  it('合并时去重、去空白，两种大小写的变量都认', () => {
    const merged = withLoopbackNoProxy({ no_proxy: ' corp.local , 127.0.0.1,' });
    expect(merged.NO_PROXY).toBe('corp.local,127.0.0.1,localhost,::1');
    expect(merged.no_proxy).toBe(merged.NO_PROXY);
  });

  it('额外环境变量可覆盖（企业私有部署要用）', () => {
    const child = fakeChild();
    const spawnFn = spawnSpy(child);
    launchSync(
      createSpawnLauncher({
        appServerPath: 'x',
        kernelHome: '/k',
        extraEnv: { EVOWORK_GATEWAY_TOKEN: 'tok' },
        spawnFn: spawnFn as never,
      }),
    );
    const env = spawnFn.mock.calls[0]![2].env;
    expect(env.EVOWORK_GATEWAY_TOKEN).toBe('tok');
  });

  it('stdout 按 utf8 解码并转成行流；写入自动补换行（NDJSON 帧）', () => {
    const child = fakeChild();
    const proc = launchSync(
      createSpawnLauncher({
        appServerPath: 'x',
        kernelHome: '/k',
        spawnFn: (() => child) as never,
      }),
    );

    const chunks: string[] = [];
    proc.onStdout((chunk: string) => chunks.push(chunk));
    child.stdout.emit('data', '{"a":1}\n');
    expect(chunks).toEqual(['{"a":1}\n']);

    proc.writeLine('{"b":2}');
    expect(child.stdin.write).toHaveBeenCalledWith('{"b":2}\n');
  });

  it('**默认丢弃内核 stderr**（它可能含正文，且格式不受我们约束）', () => {
    const child = fakeChild();
    launchSync(
      createSpawnLauncher({
        appServerPath: 'x',
        kernelHome: '/k',
        spawnFn: (() => child) as never,
      }),
    );
    // resume() 只为不让管道背压卡住子进程 —— 不订阅内容
    expect(child.stderr.resume).toHaveBeenCalled();
  });

  it('显式提供 onStderr 时才转发（排查内核问题时用）', () => {
    const child = fakeChild();
    const onStderr = vi.fn();
    launchSync(
      createSpawnLauncher({
        appServerPath: 'x',
        kernelHome: '/k',
        onStderr,
        spawnFn: (() => child) as never,
      }),
    );
    child.stderr.emit('data', 'kernel warning');
    expect(onStderr).toHaveBeenCalledWith('kernel warning');
  });

  it('退出事件带 code 与 signal（会话据此判断是崩溃还是正常退出）', () => {
    const child = fakeChild();
    const proc = launchSync(
      createSpawnLauncher({
        appServerPath: 'x',
        kernelHome: '/k',
        spawnFn: (() => child) as never,
      }),
    );

    const exits: { code: number | null; signal: string | null }[] = [];
    proc.onExit((info) => exits.push(info));
    child.emit('exit', 1, null);
    expect(exits).toEqual([{ code: 1, signal: null }]);
  });

  it('没有 stdio 管道时**立刻抛错**，而不是等到第一次写入才失败', () => {
    const broken = new EventEmitter() as EventEmitter & { stdout: null; stdin: null };
    broken.stdout = null;
    broken.stdin = null;
    expect(() =>
      launchSync(
        createSpawnLauncher({
          appServerPath: 'x',
          kernelHome: '/k',
          spawnFn: (() => broken) as never,
        }),
      ),
    ).toThrow(/stdio/);
  });
});
