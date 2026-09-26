#!/usr/bin/env node
import { createLogger, jsonLinesSink } from '@evowork/logging';

import { bootstrapFromEnv } from './config.js';
import { openIdentityDb } from './db.js';
import { createIdentityServer } from './http.js';
import { devMailer } from './mailer.js';
import { PROD_ARGON } from './password.js';
import { parseMasterKey } from './secret-box.js';
import { createIdentity } from './service.js';
import { loadOrCreateSigningKeys } from './signing-keys.js';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** 数值型环境变量。读不懂就当没给 —— 见 `port` 处的注释。 */
function numberEnv(name: string): number | undefined {
  const raw = env(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function main(): void {
  const logger = createLogger({
    service: 'identity',
    level: 'info',
    onViolation: 'drop',
    sink: jsonLinesSink((line) => process.stdout.write(`${line}\n`)),
  });
  const masterHex = env('EVOWORK_IDENTITY_MASTER_KEY');
  if (!masterHex) {
    logger.error('identity.boot.no_master_key', { reason: 'NO_MASTER_KEY' });
    process.exitCode = 1;
    return;
  }
  const db = openIdentityDb(env('EVOWORK_IDENTITY_DB') ?? ':memory:');
  const masterKey = parseMasterKey(masterHex);
  const keys = loadOrCreateSigningKeys(db, masterKey);
  const identity = createIdentity({
    db,
    keys,
    masterKey,
    mailer: devMailer(env('EVOWORK_WEB_ORIGIN') ?? 'http://127.0.0.1:5174'),
    argon: PROD_ARGON,
    publicOrigin: env('EVOWORK_PUBLIC_ORIGIN') ?? 'http://127.0.0.1:8788',
  });
  const boot = identity.bootstrap(bootstrapFromEnv(process.env));
  logger.info('identity.boot.ready', {
    tenantId: boot.tenantId,
    reason: boot.created ? 'BOOTSTRAP' : 'EXISTING',
  });
  // NaN 的 PORT 会让 `listen()` 同步抛，日志里什么都不剩（与网关同一条，见那边的注释）
  const port = numberEnv('PORT') ?? 8788;
  const host = env('HOST') ?? '127.0.0.1';
  const server = createIdentityServer({
    identity,
    keys,
    logger,
    ...(env('EVOWORK_IDENTITY_INTERNAL_TOKEN')
      ? { internalToken: env('EVOWORK_IDENTITY_INTERNAL_TOKEN') }
      : {}),
    ...(env('EVOWORK_WEB_ORIGIN') ? { webOrigin: env('EVOWORK_WEB_ORIGIN') } : {}),
  });
  server.listen(port, host, () => {
    logger.info('identity.boot.listening', { platform: process.platform });
  });
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main();
}
