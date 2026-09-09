import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateEs256KeyPair,
  POLICY_EXPIRED_COPY,
  POLICY_PACK_SCHEMA_VER,
  signPolicyPack,
  type PolicyPackPayload,
} from '@evowork/account';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncEnterprisePolicy } from '../src/main/policy-pack.js';

function payload(over: Partial<PolicyPackPayload> = {}): PolicyPackPayload {
  return {
    schemaVer: POLICY_PACK_SCHEMA_VER,
    tenant: 'ten_1',
    issuedAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
    models: { disabled: ['evowork/kimi-k3'], allowCustom: false, reason: '企业锁定' },
    allowManagedHooksOnly: true,
    disableShare: true,
    disableSlots: true,
    forceAudit: true,
    disabledProfiles: ['evowork-full'],
    ...over,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ew-pack-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('本机策略包通道', () => {
  it('未登录不向 identity 发任何请求', async () => {
    const fetchFn = vi.fn(async () => new Response('{}'));
    const view = await syncEnterprisePolicy({
      home: dir,
      requirementsPath: join(dir, 'requirements.toml'),
      identityOrigin: 'https://id.example.com',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(view.status).toBe('none');
    expect(existsSync(join(dir, 'requirements.toml'))).toBe(false);
  });

  it('验签通过才写 requirements.toml；篡改 payload 不写', async () => {
    const pair = generateEs256KeyPair();
    const envelope = signPolicyPack(pair.privatePem, payload(), pair.kid);
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/jwks')) {
        return new Response(JSON.stringify({ keys: [pair.jwk] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/policy-pack')) {
        return new Response(
          JSON.stringify({
            pack: { ...envelope, payloadJson: envelope.payloadJson.replace('ten_1', 'ten_x') },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('no', { status: 404 });
    });
    const view = await syncEnterprisePolicy({
      home: dir,
      requirementsPath: join(dir, 'requirements.toml'),
      identityOrigin: 'https://id.example.com',
      accessJwt: 'jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
      nowSec: 1_700_000_100,
    });
    expect(view.status).toBe('none');
    expect(existsSync(join(dir, 'requirements.toml'))).toBe(false);
  });

  it('有效包写入 [models]；超期不改写但只读文案是设计原句', async () => {
    const pair = generateEs256KeyPair();
    const valid = signPolicyPack(pair.privatePem, payload(), pair.kid);
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/jwks')) {
        return new Response(JSON.stringify({ keys: [pair.jwk] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ pack: valid }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const ok = await syncEnterprisePolicy({
      home: dir,
      requirementsPath: join(dir, 'requirements.toml'),
      identityOrigin: 'https://id.example.com',
      accessJwt: 'jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
      nowSec: 1_700_000_100,
    });
    expect(ok.status).toBe('valid');
    expect(readFileSync(join(dir, 'requirements.toml'), 'utf8')).toContain('allow_custom = false');

    const expired = signPolicyPack(
      pair.privatePem,
      payload({ issuedAt: 1_000, expiresAt: 2_000 }),
      pair.kid,
    );
    const fetchExpired = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/jwks')) {
        return new Response(JSON.stringify({ keys: [pair.jwk] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ pack: expired }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const before = readFileSync(join(dir, 'requirements.toml'), 'utf8');
    const dead = await syncEnterprisePolicy({
      home: dir,
      requirementsPath: join(dir, 'requirements.toml'),
      identityOrigin: 'https://id.example.com',
      accessJwt: 'jwt',
      fetchFn: fetchExpired as unknown as typeof fetch,
      nowSec: 3_000,
    });
    expect(dead.status).toBe('expired');
    expect(dead.message).toBe(POLICY_EXPIRED_COPY);
    expect(readFileSync(join(dir, 'requirements.toml'), 'utf8')).toBe(before);
  });
});
