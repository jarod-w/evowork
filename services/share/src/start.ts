/**
 * 分享托管的启动：读环境 → 体检公钥 → 起服务。
 *
 * 从 `main.ts` 拆出来是为了**能在进程内测**：下面两条判断都出过事，而它们的后果只在
 * "进程起没起、绑在哪块网卡上"看得见 —— 那是单测 `createShareServer` 碰不到的地方。
 */
import type { Server } from 'node:http';

import { checkEs256PublicPem } from '@evowork/account';
import type { Logger } from '@evowork/logging';

import { fileBlobs } from './blobs.js';
import { openShareDb } from './db.js';
import { createShareServer } from './http.js';
import { createShareService } from './service.js';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface ShareProcess {
  readonly server: Server;
  /** 关服务、停到期清扫。进程入口用不上（进程退出即结束），测试要调 */
  stop(): void;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** 体检不过返回 `undefined`，原因已记进日志；退出码由入口决定。 */
export function start(env: NodeJS.ProcessEnv, logger: Logger): ShareProcess | undefined {
  // systemd 的 EnvironmentFile 不支持多行值，所以公钥是以字面量 `\n` 连成的一行
  const checked = checkEs256PublicPem(
    read(env, 'EVOWORK_IDENTITY_PUBLIC_PEM')?.replace(/\\n/g, '\n'),
  );
  if (!checked.ok) {
    if (checked.problem === 'missing') {
      // 没有公钥就验不了上传者身份。**不降级成"不鉴权"** —— 那等于任何人都能往这里塞文件
      logger.error('share.boot.no_public_key', { reason: 'NO_PUBLIC_KEY' });
    } else {
      /*
       * 公钥**在、但用不了**，同样拒绝启动。放它起来不是"降级"，而是更难发现的一种坏：
       * 进程健康、端口在听，**每一个合法上传都被 401**，在外面与"令牌不对"分不开。
       * 2026-09-27 部署时真发生过（systemd 把不带引号值里的 `\n` 吃成了 `n`）。
       */
      logger.error('share.boot.bad_public_key', { reason: checked.problem });
    }
    return undefined;
  }

  const service = createShareService({
    db: openShareDb(read(env, 'EVOWORK_SHARE_DB') ?? ':memory:'),
    blobs: fileBlobs(read(env, 'EVOWORK_SHARE_DIR') ?? './share-blobs'),
    publicOrigin: read(env, 'EVOWORK_SHARE_ORIGIN') ?? 'http://127.0.0.1:8790',
  });

  const webDir = read(env, 'EVOWORK_SHARE_WEB_DIR');
  const server = createShareServer({
    service,
    publicPem: checked.pem,
    logger,
    ...(webDir ? { webDir } : {}),
  });

  /*
   * 默认只听环回，与 identity 一致 —— 这个服务前面总该有一层反代（TLS、与分享页同源）。
   * 此前是 `listen(port)` 不给地址 = 听所有网卡，2026-09-27 部署时要靠 systemd 的
   * `IPAddressAllow=localhost` 才把它从公网上挡下来。确实要直接对外时显式设 `0.0.0.0`。
   */
  const host = read(env, 'EVOWORK_SHARE_HOST') ?? '127.0.0.1';
  const port = Number(read(env, 'EVOWORK_SHARE_PORT') ?? '8790');
  server.listen(port, host, () => logger.info('share.listening', { port }));

  // 到期自动删除（08 §7.2 规则 4）。不 unref：这是这个进程的正经职责之一
  const sweep = setInterval(() => {
    void service.sweep().then(({ removed }) => {
      if (removed > 0) logger.info('share.swept', { itemCount: removed });
    });
  }, SWEEP_INTERVAL_MS);

  return {
    server,
    stop() {
      clearInterval(sweep);
      server.close();
    },
  };
}
