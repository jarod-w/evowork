/**
 * `~/.evowork/gateway.env` —— 本机网关的厂商密钥（拓扑 A）。
 *
 * ## 为什么必须有这个文件
 *
 * 网关只从**进程环境**读 `DEEPSEEK_API_KEY` 等（`services/gateway/src/main.ts`）。
 * 开发时从终端起 Electron，shell 里的变量在；从访达双击启动的安装包**不继承
 * 任何 shell 环境**，于是一家密钥都看不到 → 本机网关被判定 NO_KEYS 根本不起。
 * 模型目录那一次 fetch 打到没人听的 8787，界面上就变成「连不上模型网关」。
 *
 * `docs/build-and-deploy.md` 一直让人把密钥写进这个文件，但桌面宿主从来没读过它 ——
 * 手工起网关时 `set -a && . gateway.env` 能用，装好的 App 不能。
 *
 * ## 这是过渡方案，与 `gateway-token` 同一档
 *
 * 明文文件不满足「密钥不落盘」的本意。终态仍是 status.md §4 那两条未决策的候选
 * （钥匙串 / identity 短令牌）。在那之前，这个文件是 GUI 启动唯一能用的路径。
 *
 * **不记值**：Q14。这个模块的日志调用方只许报「读到了几个键」，不许报键名更不许报值。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** 网关 `main.ts` 认的那几个厂商密钥。缺一家就不注册那一家，全缺则拒绝启动。 */
export const PROVIDER_KEY_ENV = [
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'ZHIPU_API_KEY',
  'PRIVATE_MODEL_API_KEY',
] as const;

/**
 * 允许从文件灌进子进程环境的键。
 *
 * **白名单**：这个文件由用户编辑，不能把任意 `PATH=` / `ELECTRON_RUN_AS_NODE=`
 * 灌进网关子进程。厂商密钥、对应的 base URL、访问令牌，就是网关启动需要的全部。
 */
export const GATEWAY_ENV_KEYS = [
  ...PROVIDER_KEY_ENV,
  'DEEPSEEK_BASE_URL',
  'MOONSHOT_BASE_URL',
  'ZHIPU_BASE_URL',
  'PRIVATE_MODEL_BASE_URL',
  'PRIVATE_MODEL_AUTH_HEADER',
  'EVOWORK_GATEWAY_TOKEN',
  'EVOWORK_GATEWAY_TOKENS',
] as const;

const ALLOWED = new Set<string>(GATEWAY_ENV_KEYS);

/**
 * 解析 `KEY=VALUE` 文本。跳过空行与 `#` 注释，接受可选的 `export ` 前缀。
 *
 * 不认的键直接丢掉 —— 不是报错：企业可能在同一文件里写了给手工启动用的 `PORT`，
 * 让它进子进程会覆盖宿主按 `base_url` 算好的端口。
 */
export function parseGatewayEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!ALLOWED.has(key)) continue;
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function readGatewayEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseGatewayEnv(readFileSync(path, 'utf8'));
  } catch {
    // 读失败当成没有：密钥文件损坏不该让整个应用起不来，网关那一侧会再说没密钥
    return {};
  }
}

export function envHasProviderKey(env: NodeJS.ProcessEnv): boolean {
  if (PROVIDER_KEY_ENV.some((name) => (env[name] ?? '').trim() !== '')) return true;
  // 只有自定义模型时也该起网关（11 §4.1 第 ③ 层）。
  return Object.keys(env).some(
    (name) => name.startsWith('EVOWORK_MODEL_KEY_') && (env[name] ?? '').trim() !== '',
  );
}

/**
 * 进程环境优先、文件补缺 —— 与 dotenv 同一条：已经 export 的开发机变量不被文件盖掉。
 *
 * 从访达启动时进程环境是空的，文件就是唯一来源。
 */
export function mergeGatewayEnv(
  fileEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...fileEnv, ...processEnv };
}

/**
 * 把用户刚填的密钥合并进文件。空值不覆盖已有的 —— 三个框只填了一个时，
 * 另外两家不该被写成空行从文件里抹掉。
 *
 * 写完 `chmod 600`：mode 只在创建时生效，覆盖已有文件要再设一次。
 */
export function writeGatewayEnvKeys(path: string, keys: Readonly<Record<string, string>>): void {
  const current = readGatewayEnvFile(path);
  const next: Record<string, string> = { ...current };
  for (const [name, raw] of Object.entries(keys)) {
    if (!ALLOWED.has(name)) continue;
    const value = raw.trim();
    if (value.length === 0) continue;
    next[name] = value;
  }
  const lines = [
    '# EvoWork 本机网关密钥。只存在这台电脑上，应用启动时读取。',
    '# 权限 600。不要把这个文件提交进仓库或发到聊天里。',
    ...Object.entries(next).map(([k, v]) => `${k}=${v}`),
    '',
  ];
  writeFileSync(path, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * 拓扑 A：本机网关的访问令牌。用户不该知道有这么个东西。
 *
 * 内核从 `EVOWORK_GATEWAY_TOKEN` 取、网关从 `EVOWORK_GATEWAY_TOKENS` 取，
 * 两边必须逐字相同。没有现成令牌时现场签一个写进 `gateway-token`。
 *
 * **只在调用方判定是本机网关时才签**：企业部署（拓扑 B）的令牌是 identity 发的，
 * 我们自己编一个只会让下拉 401，而真正的网关在别人的机器上。
 */
export function ensureGatewayTokenFile(
  path: string,
  existing: string | undefined,
): { readonly token: string; readonly minted: boolean } {
  if (existing && existing.length > 0) return { token: existing, minted: false };
  const token = randomBytes(24).toString('base64url');
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, minted: true };
}

/** 文件里的访问令牌：单令牌键优先，其次是逗号列表的第一个。 */
export function tokenFromEnvFile(fileEnv: Record<string, string>): string | undefined {
  const single = fileEnv.EVOWORK_GATEWAY_TOKEN?.trim();
  if (single) return single;
  const first = fileEnv.EVOWORK_GATEWAY_TOKENS?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}
