/**
 * `~/.evowork/app.toml` —— EvoWork 自己的配置（11 §3.2）。
 *
 * **不进内核的 `config.toml`。** 那个文件是内核的，混进去等于让内核配置承载我们的凭据
 * （`service-host.ts` 已经为 `gateway-token` 付过一次这个代价）。
 *
 * `mode` 回答的是「默认模型的上游在哪」，不是「网关在哪」—— 网关在本机（D11）。
 * 方向必须是 mode → 上游，不能反过来用 URL 反推：云端托管与企业私有的 base_url
 * 都不是 loopback，但令牌来源、密钥归属、登录目标 IdP 全都不同。
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type GatewayMode = 'local' | 'hosted' | 'private';

export type SecretFallback = 'plaintext' | 'ephemeral';

export interface AppConfig {
  readonly gateway: {
    readonly mode: GatewayMode;
    readonly upstreamBaseUrl: string;
  };
  readonly secrets?: {
    readonly fallback?: SecretFallback | undefined;
  };
}

export const DEFAULT_APP_CONFIG: AppConfig = Object.freeze({
  gateway: { mode: 'local' as const, upstreamBaseUrl: '' },
});

const MODES = new Set<string>(['local', 'hosted', 'private']);
const FALLBACKS = new Set<string>(['plaintext', 'ephemeral']);

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 解析 `app.toml`。缺段、缺键、非法 mode 都退到默认，**不抛** ——
 * 一份坏掉的配置不该让整个应用起不来；错了的 mode 会让上游判断落到 local，
 * 那是「只用自定义模型」而不是「假装托管还活着」。
 */
export function parseAppToml(text: string): AppConfig {
  let section = '';
  let mode: GatewayMode = 'local';
  let upstreamBaseUrl = '';
  let fallback: SecretFallback | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      section = line.replaceAll('[', '').replaceAll(']', '');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (section === 'gateway') {
      if (key === 'mode' && MODES.has(value)) mode = value as GatewayMode;
      if (key === 'upstream_base_url') upstreamBaseUrl = value;
    }
    if (section === 'secrets' && key === 'fallback' && FALLBACKS.has(value)) {
      fallback = value as SecretFallback;
    }
  }
  return {
    gateway: { mode, upstreamBaseUrl },
    ...(fallback !== undefined ? { secrets: { fallback } } : {}),
  };
}

export function readAppConfig(path: string): AppConfig {
  if (!existsSync(path)) return DEFAULT_APP_CONFIG;
  try {
    return parseAppToml(readFileSync(path, 'utf8'));
  } catch {
    return DEFAULT_APP_CONFIG;
  }
}

export function serializeAppConfig(config: AppConfig): string {
  const lines = [
    '# EvoWork 自己的配置。不要写进内核的 config.toml。',
    '# mode = 默认模型的上游在哪（local / hosted / private），不是网关在哪。',
    '[gateway]',
    `mode = "${config.gateway.mode}"`,
    `upstream_base_url = "${config.gateway.upstreamBaseUrl}"`,
  ];
  if (config.secrets?.fallback) {
    lines.push('', '[secrets]', `fallback = "${config.secrets.fallback}"`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeAppConfig(path: string, config: AppConfig): void {
  writeFileSync(path, serializeAppConfig(config), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * 环回地址判定。与 `gateway-process.ts` 的 `isLocalGateway` 同一口径，
 * 抽在这里是为了让 app.toml 的一次性迁移不依赖起进程那一层。
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * 老装机：`config.toml` 里已有非 loopback 的 base_url，而 `app.toml` 还不存在。
 *
 * **只推断一次并写回。** 之后 mode 是权威，不再看 URL。分不清 hosted 与 private
 * 时落到 `private`：那条路径保留 `staticTokenAuth`，不要求我们的账号
 * （11 验收口径 7）。猜成 hosted 会去找一个还不存在的 identity。
 */
export function inferModeFromKernelBaseUrl(baseUrl: string): {
  readonly mode: GatewayMode;
  readonly upstreamBaseUrl: string;
} {
  if (!baseUrl || isLoopbackBaseUrl(baseUrl)) {
    return { mode: 'local', upstreamBaseUrl: '' };
  }
  return { mode: 'private', upstreamBaseUrl: baseUrl };
}

export interface EnsureAppConfigResult {
  readonly config: AppConfig;
  /** 这次调用写了新文件（含一次性 URL 反推） */
  readonly written: boolean;
}

/**
 * 没有 `app.toml` 就按内核 `base_url` 反推一次写上。文件已在则原样读，不再推断。
 */
export function ensureAppConfig(path: string, kernelBaseUrl: string): EnsureAppConfigResult {
  if (existsSync(path)) return { config: readAppConfig(path), written: false };
  const inferred = inferModeFromKernelBaseUrl(kernelBaseUrl);
  const config: AppConfig = { gateway: inferred };
  writeAppConfig(path, config);
  return { config, written: true };
}

/** 用户选定密钥库不可用时的落法。写进 app.toml，下次启动不再问。 */
export function writeSecretFallback(path: string, fallback: SecretFallback): AppConfig {
  const current = readAppConfig(path);
  const next: AppConfig = {
    gateway: current.gateway,
    secrets: { fallback },
  };
  writeAppConfig(path, next);
  return next;
}

/** 测试用：把写坏的文件挪开，避免下次启动读到一份半截 toml。 */
export function quarantineAppConfig(path: string): void {
  if (!existsSync(path)) return;
  renameSync(path, `${path}.broken`);
}
