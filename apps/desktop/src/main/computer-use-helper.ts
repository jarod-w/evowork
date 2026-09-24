import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ComputerUseError,
  FrameDecoder,
  encodeFrame,
  type ResultCode,
} from '@evowork/computer-use';
import type { NativeHelper } from './computer-use-host.js';
const exec = promisify(execFile);
/** 发布标记不是签名验证的替代；只有正式 macOS 验收后才可随包置 true。 */
export function readComputerUseRelease(appPath: string, buildVersion: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(appPath, 'Contents/Resources/release.json'), 'utf8'),
    ) as Record<string, unknown>;
    return (
      manifest.protocolVersion === 1 &&
      manifest.buildVersion === buildVersion &&
      manifest.releaseVerified === true
    );
  } catch {
    return false;
  }
}
export function createNativeHelper(
  appPath: string,
  buildVersion: string,
  mainExecutable: string,
): NativeHelper {
  let child: ReturnType<typeof spawn> | undefined;
  let pending:
    | {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let busy = false;
  let generation = 0;
  function stop() {
    generation++;
    const previous = child;
    child = undefined;
    previous?.kill();
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new ComputerUseError('USER_STOPPED'));
      pending = undefined;
    }
  }
  async function launch() {
    if (child) return;
    const startedAt = generation;
    // 同 Team ID 验证；不接受 ad-hoc/未签名组件，也不在出错时回退到不验证。
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
    const [helperSignature, mainSignature] = await Promise.all([
      exec('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]),
      exec('/usr/bin/codesign', ['-dv', '--verbose=4', mainExecutable]),
    ]);
    const team = /TeamIdentifier=([A-Z0-9]+)/.exec(helperSignature.stderr)?.[1];
    if (!team || team !== /TeamIdentifier=([A-Z0-9]+)/.exec(mainSignature.stderr)?.[1])
      throw new ComputerUseError('POLICY_DENIED');
    if (generation !== startedAt) throw new ComputerUseError('USER_STOPPED');
    const decoder = new FrameDecoder();
    const process = spawn(join(appPath, 'Contents/MacOS/EvoWorkComputerUse'), [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { EVOWORK_CUA_BUILD_VERSION: buildVersion },
    });
    child = process;
    process.on('error', stop);
    process.on('exit', () => {
      if (child === process) stop();
    });
    process.stdout?.on('data', (data: Buffer) => {
      try {
        for (const raw of decoder.push(data)) {
          const result = raw as { ok?: boolean; value?: unknown; code?: ResultCode };
          const request = pending;
          if (!request) {
            stop();
            return;
          }
          pending = undefined;
          clearTimeout(request.timer);
          if (result.ok) request.resolve(result.value);
          else request.reject(new ComputerUseError(result.code ?? 'INTERNAL'));
        }
      } catch {
        stop();
      }
    });
  }
  return {
    stop,
    async call(method, params = {}) {
      if (busy) throw new ComputerUseError('POLICY_DENIED');
      busy = true;
      try {
        await launch();
        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new ComputerUseError('TIMEOUT'));
            stop();
          }, 30000);
          pending = { resolve, reject, timer };
          child!.stdin!.write(encodeFrame({ method, params }));
        });
      } finally {
        busy = false;
      }
    },
  };
}
