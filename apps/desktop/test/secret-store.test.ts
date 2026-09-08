/**
 * 密钥存储（11 §4.3 / Q34=A）。
 *
 * 断言写后果：迁完之后源文件还在（改了名），密文文件里看不到密钥原文，
 * 密钥库不可用时不静默落明文。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  keyLooksValid,
  last4,
  last4OfKeys,
  loadSecrets,
  memoryCodec,
  migrateGatewayEnv,
  plaintextCodec,
  saveSecrets,
  secretStoreStatus,
  secretsToEnv,
} from '../src/main/secret-store.js';

describe('形状与后四位', () => {
  it('太短或带空白的不当成密钥', () => {
    expect(keyLooksValid('sk')).toBe(false);
    expect(keyLooksValid('sk live secret')).toBe(false);
    expect(keyLooksValid('sk-live-secret')).toBe(true);
  });

  it('对外只给后四位，不是完整密钥', () => {
    expect(last4('sk-live-secret-abcd')).toBe('abcd');
    expect(last4OfKeys({ DEEPSEEK_API_KEY: 'sk-live-secret-abcd' })).toEqual({
      DEEPSEEK_API_KEY: 'abcd',
    });
  });
});

describe('编解码往返', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ew-sec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('写进去的能读回来，磁盘上看不到原文', () => {
    const path = join(dir, 'secrets.bin');
    const secret = 'sk-live-secret-abcd';
    expect(saveSecrets(path, { DEEPSEEK_API_KEY: secret }, memoryCodec())).toEqual({ ok: true });
    const loaded = loadSecrets(path, memoryCodec());
    expect(loaded.keys.DEEPSEEK_API_KEY).toBe(secret);
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain('"kind":"memory"');
  });

  it('密钥库不可用时 save 拒绝，不落明文', () => {
    const path = join(dir, 'secrets.bin');
    const closed = { ...memoryCodec(), available: false };
    const result = saveSecrets(path, { DEEPSEEK_API_KEY: 'sk-live-secret' }, closed);
    expect(result).toEqual({ ok: false, needsChoice: true });
    expect(existsSync(path)).toBe(false);
  });

  it('用户选了明文兜底才写 600 文件，且 kind 可审计', () => {
    const path = join(dir, 'secrets.bin');
    expect(saveSecrets(path, { DEEPSEEK_API_KEY: 'sk-live-secret' }, plaintextCodec())).toEqual({
      ok: true,
    });
    const loaded = loadSecrets(path, plaintextCodec());
    expect(loaded.kind).toBe('plaintext-fallback');
    expect(secretStoreStatus(plaintextCodec()).kind).toBe('plaintext-fallback');
  });
});

describe('从 gateway.env 迁移', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ew-mig-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('导入后把源文件改名为 .migrated，不删', () => {
    const envPath = join(dir, 'gateway.env');
    const secretsPath = join(dir, 'secrets.bin');
    writeFileSync(envPath, 'DEEPSEEK_API_KEY=sk-from-file-xxxx\n', 'utf8');
    const result = migrateGatewayEnv({
      gatewayEnvPath: envPath,
      secretsPath,
      codec: memoryCodec(),
    });
    expect(result).toEqual({ migrated: true, imported: 1 });
    expect(existsSync(envPath)).toBe(false);
    expect(existsSync(`${envPath}.migrated`)).toBe(true);
    expect(readFileSync(`${envPath}.migrated`, 'utf8')).toContain('sk-from-file-xxxx');
    expect(loadSecrets(secretsPath, memoryCodec()).keys.DEEPSEEK_API_KEY).toBe('sk-from-file-xxxx');
  });

  it('密钥库不可用时不迁，继续留着 gateway.env', () => {
    const envPath = join(dir, 'gateway.env');
    writeFileSync(envPath, 'DEEPSEEK_API_KEY=sk-from-file-xxxx\n', 'utf8');
    const closed = { ...memoryCodec(), available: false };
    const result = migrateGatewayEnv({
      gatewayEnvPath: envPath,
      secretsPath: join(dir, 'secrets.bin'),
      codec: closed,
    });
    expect(result.needsChoice).toBe(true);
    expect(existsSync(envPath)).toBe(true);
    expect(existsSync(join(dir, 'secrets.bin'))).toBe(false);
  });
});

describe('灌进网关环境', () => {
  it('P0 槽用原名，自定义模型用 EVOWORK_MODEL_KEY_*', () => {
    const env = secretsToEnv({
      DEEPSEEK_API_KEY: 'sk-ds',
      'custom:evowork/my-llama': 'sk-llama',
    });
    expect(env.DEEPSEEK_API_KEY).toBe('sk-ds');
    expect(env.EVOWORK_MODEL_KEY_evowork_my_llama).toBe('sk-llama');
    expect(JSON.stringify(env)).not.toContain('custom:');
  });
});
