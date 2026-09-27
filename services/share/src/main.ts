#!/usr/bin/env node
/**
 * 分享托管服务的进程入口。
 *
 * 它**不与 identity 同进程**：identity 的 DDL 被测试守着不许有内容列，
 * 而这里存的就是文件字节。两个进程 = 两套库 = 那条对外承诺在结构上成立。
 */
import { createLogger, jsonLinesSink } from '@evowork/logging';

import { fileBlobs } from './blobs.js';
import { openShareDb } from './db.js';
import { createShareServer } from './http.js';
import { createShareService } from './service.js';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function main(): void {
  const logger = createLogger({
    service: 'share',
    level: 'info',
    onViolation: 'drop',
    sink: jsonLinesSink((line) => process.stdout.write(`${line}\n`)),
  });

  const publicPem = env('EVOWORK_IDENTITY_PUBLIC_PEM')?.replace(/\\n/g, '\n');
  if (!publicPem) {
    // 没有公钥就验不了上传者身份。**不降级成"不鉴权"** —— 那等于任何人都能往这里塞文件
    logger.error('share.boot.no_public_key', { reason: 'NO_PUBLIC_KEY' });
    process.exitCode = 1;
    return;
  }

  const publicOrigin = env('EVOWORK_SHARE_ORIGIN') ?? 'http://127.0.0.1:8790';
  const service = createShareService({
    db: openShareDb(env('EVOWORK_SHARE_DB') ?? ':memory:'),
    blobs: fileBlobs(env('EVOWORK_SHARE_DIR') ?? './share-blobs'),
    publicOrigin,
  });

  const server = createShareServer({
    service,
    publicPem,
    logger,
    ...(env('EVOWORK_SHARE_WEB_DIR') ? { webDir: env('EVOWORK_SHARE_WEB_DIR') } : {}),
  });

  const port = Number(env('EVOWORK_SHARE_PORT') ?? '8790');
  server.listen(port, () => logger.info('share.listening', { port }));

  // 到期自动删除（08 §7.2 规则 4）。不 unref：这是这个进程的正经职责之一
  setInterval(() => {
    void service.sweep().then(({ removed }) => {
      if (removed > 0) logger.info('share.swept', { itemCount: removed });
    });
  }, SWEEP_INTERVAL_MS);
}

main();
