/**
 * 厂商密钥与 refresh token 的本机存储（11 §4.3，Q34=A）。
 *
 * 密文写 `~/.evowork/secrets.bin`。编解码是注入的：生产用 Electron `safeStorage`
 * （钥匙串 / DPAPI / libsecret），测试用内存编解码，密钥库不可用且用户显式选了
 * 明文兜底时用 identity 编解码。
 *
 * **这一层不把密钥交回渲染进程。** 对外只给后四位。完整密钥只在宿主解密后
 * 灌进网关子进程环境（网关本来就只从进程环境读密钥）。
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { customModelKeyEnv } from '@evowork/gateway';

import { parseGatewayEnv, PROVIDER_KEY_ENV } from './gateway-env.js';

export type SecretStoreKind = 'keychain' | 'dpapi' | 'libsecret' | 'plaintext-fallback' | 'memory';

export interface SecretCodec {
  readonly kind: SecretStoreKind;
  readonly available: boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(cipher: Uint8Array): string;
}

export interface SecretStoreStatus {
  readonly available: boolean;
  readonly kind: SecretStoreKind;
  readonly needsChoice: boolean;
}

export const SECRET_STORE_UNAVAILABLE =
  '这台电脑上没有可用的系统密钥库，EvoWork 无法加密保存 API 密钥。' +
  '可以选择：以 600 权限的明文文件保存（仅本机可读，但同机的其他程序能读到），' +
  '或每次启动时手动填入（不保存）。';

const MIN_KEY_LENGTH = 8;

export function memoryCodec(): SecretCodec {
  return {
    kind: 'memory',
    available: true,
    encrypt: (plain) => new TextEncoder().encode(plain),
    decrypt: (cipher) => new TextDecoder().decode(cipher),
  };
}

export function plaintextCodec(): SecretCodec {
  return {
    kind: 'plaintext-fallback',
    available: true,
    encrypt: (plain) => new TextEncoder().encode(plain),
    decrypt: (cipher) => new TextDecoder().decode(cipher),
  };
}

export function electronCodec(
  api: {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Uint8Array;
    decryptString(encrypted: Uint8Array): string;
  },
  platform: string,
): SecretCodec {
  const kind: SecretStoreKind =
    platform === 'darwin' ? 'keychain' : platform === 'win32' ? 'dpapi' : 'libsecret';
  const available = api.isEncryptionAvailable();
  return {
    kind,
    available,
    encrypt: (plain) => new Uint8Array(api.encryptString(plain)),
    decrypt: (cipher) => api.decryptString(Buffer.from(cipher)),
  };
}

export function secretStoreStatus(
  codec: SecretCodec | undefined,
  fallback?: 'plaintext' | 'ephemeral',
): SecretStoreStatus {
  if (codec?.available) {
    return { available: true, kind: codec.kind, needsChoice: false };
  }
  if (fallback === 'plaintext') {
    return { available: true, kind: 'plaintext-fallback', needsChoice: false };
  }
  if (fallback === 'ephemeral') {
    return { available: true, kind: 'memory', needsChoice: false };
  }
  return {
    available: false,
    kind: codec?.kind ?? 'libsecret',
    needsChoice: true,
  };
}

export function last4(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

export function keyLooksValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= MIN_KEY_LENGTH && !/\s/.test(trimmed);
}

interface Envelope {
  readonly v: 1;
  readonly kind: SecretStoreKind;
  readonly payload: string;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

function codecForKind(kind: SecretStoreKind, preferred: SecretCodec): SecretCodec {
  if (kind === 'plaintext-fallback') return plaintextCodec();
  if (kind === 'memory') return memoryCodec();
  return preferred;
}

export function parseSecretsPayload(plain: string): Record<string, string> {
  const parsed = JSON.parse(plain) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value;
  }
  return out;
}

export interface LoadSecretsResult {
  readonly keys: Readonly<Record<string, string>>;
  readonly kind?: SecretStoreKind | undefined;
  readonly needsChoice?: boolean | undefined;
}

export function loadSecrets(path: string, codec: SecretCodec): LoadSecretsResult {
  if (!existsSync(path)) return { keys: {} };
  let envelope: Envelope;
  try {
    envelope = JSON.parse(readFileSync(path, 'utf8')) as Envelope;
  } catch {
    return { keys: {} };
  }
  if (envelope.v !== 1 || typeof envelope.payload !== 'string') return { keys: {} };
  const used = codecForKind(envelope.kind, codec);
  if (!used.available) return { keys: {}, kind: envelope.kind, needsChoice: true };
  try {
    const plain = used.decrypt(fromBase64(envelope.payload));
    return { keys: parseSecretsPayload(plain), kind: envelope.kind };
  } catch {
    return { keys: {}, kind: envelope.kind };
  }
}

export function saveSecrets(
  path: string,
  keys: Readonly<Record<string, string>>,
  codec: SecretCodec,
): { readonly ok: true } | { readonly ok: false; readonly needsChoice: true } {
  if (!codec.available) return { ok: false, needsChoice: true };
  const envelope: Envelope = {
    v: 1,
    kind: codec.kind,
    payload: toBase64(codec.encrypt(JSON.stringify(keys))),
  };
  writeFileSync(path, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return { ok: true };
}

export function secretsToEnv(keys: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [slot, value] of Object.entries(keys)) {
    if (value.trim().length === 0) continue;
    if (slot.startsWith('custom:')) {
      const id = slot.slice('custom:'.length);
      env[customModelKeyEnv(id)] = value;
    } else {
      env[slot] = value;
    }
  }
  return env;
}

export function last4OfKeys(
  keys: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [slot, value] of Object.entries(keys)) {
    if (value.trim().length > 0) out[slot] = last4(value);
  }
  return out;
}

export interface MigrateGatewayEnvResult {
  readonly migrated: boolean;
  readonly needsChoice?: boolean | undefined;
  readonly imported?: number | undefined;
}

/**
 * 首次启动：`gateway.env` 在、`secrets.bin` 不在 → 导入后把源文件改名为
 * `gateway.env.migrated`，**不删**。`docs/build-and-deploy.md` 一直让人写那个文件，
 * 静默删掉会让照文档操作的人困惑。
 *
 * 密钥库不可用时**不迁**：迁了就要落一份明文，而用户还没选。继续读 gateway.env。
 */
export function migrateGatewayEnv(options: {
  readonly gatewayEnvPath: string;
  readonly secretsPath: string;
  readonly codec: SecretCodec;
}): MigrateGatewayEnvResult {
  if (existsSync(options.secretsPath)) return { migrated: false };
  if (!existsSync(options.gatewayEnvPath)) return { migrated: false };
  if (!options.codec.available) return { migrated: false, needsChoice: true };
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseGatewayEnv(readFileSync(options.gatewayEnvPath, 'utf8'));
  } catch {
    return { migrated: false };
  }
  const keys: Record<string, string> = {};
  for (const name of PROVIDER_KEY_ENV) {
    const value = fileEnv[name]?.trim();
    if (value) keys[name] = value;
  }
  if (Object.keys(keys).length === 0) return { migrated: false };
  const saved = saveSecrets(options.secretsPath, keys, options.codec);
  if (!saved.ok) return { migrated: false, needsChoice: true };
  renameSync(options.gatewayEnvPath, `${options.gatewayEnvPath}.migrated`);
  return { migrated: true, imported: Object.keys(keys).length };
}

export function upsertKey(
  keys: Readonly<Record<string, string>>,
  slot: string,
  value: string,
): Record<string, string> {
  return { ...keys, [slot]: value.trim() };
}

export function removeKey(
  keys: Readonly<Record<string, string>>,
  slot: string,
): Record<string, string> {
  const next = { ...keys };
  delete next[slot];
  return next;
}
