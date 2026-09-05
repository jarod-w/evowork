#!/usr/bin/env node
/**
 * 网关进程入口。
 *
 * 两种形态共用这一个入口（Q14）：
 *   · **云端统一托管**：密钥在我们的密钥管理里，`EVOWORK_GATEWAY_TOKENS` 由 identity 服务签发；
 *   · **企业私有部署包**：客户自持厂商密钥，`authenticate` 换成客户自己的实现或简单静态 token。
 *
 * 配置全部来自环境变量，**不读配置文件也不落盘任何密钥**（K6 / Q14）。
 * `.env` 在 `.gitignore` 里；容器里用 secret 挂载。
 */
import { createLogger, jsonLinesSink } from '@evowork/logging';

import { createModelRegistry, P0_MODELS, type ModelRegistryEntry } from './capabilities.js';
import { DEFAULT_BASE_URL, PROVIDERS } from './providers/registry.js';
import type { ProviderConfig } from './providers/types.js';
import { createGatewayServer } from './server.js';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** 每家的密钥从环境变量取。**缺失的厂商不注册进模型表** —— 让它出现在下拉里再报错更糟。 */
const KEY_ENV: Readonly<Record<string, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  private: 'PRIVATE_MODEL_API_KEY',
};

const BASE_URL_ENV: Readonly<Record<string, string>> = {
  deepseek: 'DEEPSEEK_BASE_URL',
  moonshot: 'MOONSHOT_BASE_URL',
  zhipu: 'ZHIPU_BASE_URL',
  private: 'PRIVATE_MODEL_BASE_URL',
};

export function buildConfigResolver(): (model: ModelRegistryEntry) => ProviderConfig {
  return (model) => {
    const apiKey = env(KEY_ENV[model.provider] ?? '') ?? '';
    const baseUrl =
      env(BASE_URL_ENV[model.provider] ?? '') ?? DEFAULT_BASE_URL[model.provider] ?? '';
    return {
      baseUrl,
      apiKey,
      ...(env('PRIVATE_MODEL_AUTH_HEADER') && model.provider === 'private'
        ? { extraHeaders: { authorization: env('PRIVATE_MODEL_AUTH_HEADER') as string } }
        : {}),
      timeoutMs: Number(env('GATEWAY_UPSTREAM_TIMEOUT_MS') ?? 300_000),
    };
  };
}

/** 只保留"密钥齐了"的模型。 */
export function availableModels(): ModelRegistryEntry[] {
  return P0_MODELS.filter((model) => Boolean(env(KEY_ENV[model.provider] ?? '')));
}

/**
 * 静态 token 鉴权（私有部署的默认）。云端托管形态下换成 identity 服务的校验。
 *
 * 用常量时间比较：token 校验的时序侧信道在这种薄服务上是真实存在的，而修它的成本是 3 行。
 */
export function staticTokenAuth(tokens: readonly string[]): (auth: string | undefined) => boolean {
  const expected = tokens.map((t) => `Bearer ${t}`);
  return (auth) => {
    if (!auth) return false;
    return expected.some((candidate) => timingSafeEqual(candidate, auth));
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function main(): void {
  const port = Number(env('PORT') ?? 8787);
  const host = env('HOST') ?? '127.0.0.1';
  const tokens = (env('EVOWORK_GATEWAY_TOKENS') ?? '').split(',').filter((t) => t.length > 0);

  const logger = createLogger({
    service: 'gateway',
    level: (env('LOG_LEVEL') as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    // 生产用 drop：日志不该让业务失败，而丢弃的方向永远是"少写"
    onViolation: 'drop',
    sink: jsonLinesSink((line) => process.stdout.write(`${line}\n`)),
    base: { appVersion: env('EVOWORK_VERSION') ?? '0.0.0' },
  });

  const models = availableModels();
  if (models.length === 0) {
    // 没有任何厂商密钥就别假装能服务：起一个"看起来正常但每次请求都失败"的网关，
    // 会让排查从"网关没配密钥"变成"模型为什么总是报错"
    logger.error('gateway.boot.no_models', { reason: 'NO_PROVIDER_KEYS' });
    process.exitCode = 1;
    return;
  }
  if (tokens.length === 0) {
    logger.error('gateway.boot.no_tokens', { reason: 'NO_AUTH_TOKENS' });
    process.exitCode = 1;
    return;
  }

  const server = createGatewayServer({
    models: createModelRegistry(models),
    providers: PROVIDERS,
    configFor: buildConfigResolver(),
    logger,
    authenticate: staticTokenAuth(tokens),
  });

  server.listen(port, host, () => {
    logger.info('gateway.boot.listening', {
      // 端口不是秘密，但也不是"内容"——它是合法的运维字段
      concurrency: models.length,
      platform: process.platform,
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('gateway.boot.shutdown', { reason: signal });
      server.close(() => process.exit(0));
    });
  }
}

// `node src/main.ts` 直接运行时启动；被 import 时不启动（测试要用上面几个导出）
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main();
}
