/**
 * `~/.evowork/app.toml` —— **EvoWork 自己的配置**（11 §3.2 / D11，M10a）。
 *
 * ## 为什么不写进 `config.toml`
 *
 * 那是**内核的**配置文件。把我们的拓扑与凭据混进去，等于让内核的配置文件承载
 * EvoWork 的状态（`service-host.ts` 的 `EvoworkPaths.gatewayToken` 已经论证过一次）。
 *
 * ## 为什么值得为一个字段加一个文件
 *
 * 因为在此之前"我们是什么部署形态"这件事是**从 URL 反推的**：
 * `isLocalGateway(base_url)` 返回一个布尔值，决定要不要起本机网关、要不要自签令牌。
 * 两种形态时一个布尔值够用；而 Q36=A 之后**同一台机器上可以同时有两种上游**
 * （用户自己的 BYOK 模型 + 管理员配置的托管模型），且「云端托管」与「企业私有」的
 * base_url 都不是 loopback，**但令牌来源、密钥归属、登录目标 IdP 全都不同**。
 * 一个布尔值分不开，而分错的表现是"下拉 401，而真正的网关在别人的机器上"。
 *
 * 所以方向必须是 **mode → 上游**，不能反过来（D11 的机制化第①条）：
 * `mode` 是权威，`isLocalGateway()` 退役为**一次性兼容读取** —— 老装机的
 * `config.toml` 里已经有一个非 loopback 的 base_url 而 `app.toml` 还不存在时，
 * 按 URL 反推**一次**并写回 `app.toml`，之后不再推断。
 *
 * ## 字段名是 `upstream_base_url` 而不是 `base_url`
 *
 * 内核的 `config.toml` 里已经有一个 `model_providers.evowork.base_url`，而那一个
 * 描述的是"网关在哪"。两个都叫 `base_url` 正是把"网关在哪"与"上游在哪"混成一件事的
 * 源头 —— 这个混淆已经付过一次代价（11 §1.2 问题 1）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * **默认模型的上游在哪**（不是"网关在哪"：网关永远在本机，D11）。
 *
 *   · `local`   —— 没有默认模型，只有用户自己的自定义模型（Q30=A 的常态）
 *   · `hosted`  —— 我们的云端网关（需要账号，M10b）
 *   · `private` —— 客户机房的网关（企业私有部署包，Q14）
 */
export type GatewayMode = 'local' | 'hosted' | 'private';

export interface AppConfig {
  readonly mode: GatewayMode;
  /** `private` 时必填；`local` / `hosted` 由宿主按 mode 生成，**不接受手填** */
  readonly upstreamBaseUrl?: string | undefined;
}

export const DEFAULT_APP_CONFIG: AppConfig = Object.freeze({ mode: 'local' });

const MODES: readonly GatewayMode[] = ['local', 'hosted', 'private'];

/**
 * 解析 `app.toml`。**只认两个键**，所以用正则而不是引入 TOML 解析器
 * （同 `model-catalog.ts` 的 `parseGatewayBaseUrl`：需要的是两个值，不是整棵配置树）。
 *
 * 不认识的 `mode` **退到 `local`** 而不是抛错：一个手改坏了的配置文件不该让应用打不开，
 * 而 `local` 是最保守的那一档（不连我们的云、不要求账号）。
 */
export function parseAppConfig(text: string): AppConfig {
  let mode: GatewayMode = 'local';
  let upstream: string | undefined;
  let inGateway = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line === '') continue;
    if (line.startsWith('[')) {
      inGateway = line === '[gateway]';
      continue;
    }
    if (!inGateway) continue;
    const m = /^mode\s*=\s*["']([^"']*)["']/.exec(line);
    if (m?.[1] && MODES.includes(m[1] as GatewayMode)) mode = m[1] as GatewayMode;
    const u = /^upstream_base_url\s*=\s*["']([^"']*)["']/.exec(line);
    if (u?.[1] && u[1].trim() !== '') upstream = u[1].trim();
  }
  return { mode, ...(upstream !== undefined ? { upstreamBaseUrl: upstream } : {}) };
}

export function serializeAppConfig(config: AppConfig): string {
  return [
    '# EvoWork 自己的配置（不是内核的 config.toml —— 见 main/app-config.ts 的头注释）。',
    '',
    '[gateway]',
    '# 默认模型的上游在哪：local = 只有自己的自定义模型 · hosted = 我们的云端网关 · private = 客户机房的网关',
    `mode = "${config.mode}"`,
    '# private 时必填。local / hosted 由应用按 mode 生成，手填无效',
    `upstream_base_url = "${config.upstreamBaseUrl ?? ''}"`,
    '',
  ].join('\n');
}

export function readAppConfig(path: string): AppConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseAppConfig(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeAppConfig(path: string, config: AppConfig): void {
  writeFileSync(path, serializeAppConfig(config), { encoding: 'utf8', mode: 0o600 });
}

/**
 * 拿到当前拓扑，**必要时做且只做一次 URL 反推**（D11 的机制化第①条）。
 *
 * 三种情况：
 *
 *   ① `app.toml` 有 → 用它，**不看任何 URL**。这是稳定态；
 *   ② 没有，且内核的 `base_url` 指向 loopback（或读不到）→ `local`，写回文件；
 *   ③ 没有，且 `base_url` 指向别处 → 这是一台**老装机**，它已经在用企业私有网关了。
 *      按 `private` + 那个 URL 反推一次并写回 —— 若不做这一步，升级后这台机器会
 *      突然变成 `local`：本机起一个拿不到任何厂商密钥的网关，而真正的网关在服务器上
 *      （`gateway-process.ts` 头注释里描述的正是这个场景）。
 *
 * 返回 `inferred` 是为了让②③能被日志区分开 —— 一次静默的反推在排查时看不见。
 */
export function resolveAppConfig(options: {
  readonly path: string;
  /** 内核 `config.toml` 里的 `base_url`（只在 `app.toml` 缺席时才被看一眼） */
  readonly kernelBaseUrl: string;
  readonly isLoopback: (url: string) => boolean;
}): { readonly config: AppConfig; readonly inferred: boolean } {
  const existing = readAppConfig(options.path);
  if (existing) return { config: existing, inferred: false };

  const remote = !options.isLoopback(options.kernelBaseUrl);
  const config: AppConfig = remote
    ? { mode: 'private', upstreamBaseUrl: options.kernelBaseUrl }
    : DEFAULT_APP_CONFIG;
  try {
    writeAppConfig(options.path, config);
  } catch {
    // 写不进去（只读目录）不该阻塞启动：这一轮按推断值跑，下一轮再推一次
  }
  return { config, inferred: remote };
}
