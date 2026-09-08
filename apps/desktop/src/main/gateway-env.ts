/**
 * `~/.evowork/gateway.env` 的**解析**（M10a 之后它只剩这一件事）。
 *
 * ## 它以前是什么、现在是什么
 *
 * 以前：厂商密钥的唯一 GUI 来源（明文文件，600），宿主启动时读它、设置页写它。
 * 现在（Q34=A）：密钥的正式家是**系统钥匙串**（`secret-store.ts`）。这个文件只在两处被读：
 *
 *   ① **一次性迁移** —— 首次启动把里面的密钥导入钥匙串，然后改名成 `gateway.env.migrated`；
 *   ② **钥匙串不可用的机器**（无 keyring 的 Linux）—— 那时不迁移、不改名、继续读它，
 *      并在设置页让用户二选一（明文保存 / 每次手填）。理由见 `model-access.ts` 的 `legacyEnv`：
 *      悄悄让产品不可用，比继续读一个用户自己创建的文件糟得多。
 *
 * ## 这个模块里**没有任何写盘函数**（2026-09-08 删掉了三个）
 *
 * `writeGatewayEnvKeys` / `ensureGatewayTokenFile` / `tokenFromEnvFile` 都被删了，
 * 不是因为没人调用，而是因为**留着它们就等于留着一条写明文密钥的入口**。
 * Q34 的整个意义是让那条路不存在；一个"暂时没人用但随手能用"的写明文函数，
 * 迟早会在某次赶工里被重新接上（有测试守着这件事，见 `gateway-env.test.ts` 末尾）。
 *
 * **不记值**：Q14。这个模块的日志调用方只许报「读到了几个键」，不许报键名更不许报值。
 */
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

export function envHasProviderKey(env: NodeJS.ProcessEnv): boolean {
  return PROVIDER_KEY_ENV.some((name) => (env[name] ?? '').trim() !== '');
}
