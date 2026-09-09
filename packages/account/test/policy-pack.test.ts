import { describe, expect, it } from 'vitest';

import { generateEs256KeyPair } from '../src/jwt.js';
import {
  encodePolicyPackPayload,
  evaluatePolicyPack,
  parsePolicyPackPayload,
  POLICY_EXPIRED_COPY,
  POLICY_PACK_SCHEMA_VER,
  policyPackToRequirementsToml,
  signPolicyPack,
  verifyPolicyPack,
  type PolicyPackPayload,
} from '../src/policy-pack.js';

function payload(over: Partial<PolicyPackPayload> = {}): PolicyPackPayload {
  return {
    schemaVer: POLICY_PACK_SCHEMA_VER,
    tenant: 'ten_1',
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_086_400,
    models: { disabled: ['evowork/kimi-k3'], allowCustom: false, reason: '企业锁定' },
    allowManagedHooksOnly: true,
    disableShare: true,
    disableSlots: true,
    forceAudit: true,
    disabledProfiles: ['evowork-full'],
    ...over,
  };
}

describe('签名策略包', () => {
  it('自己签的自己验得过，且验的是原文而不是再 stringify 一遍', () => {
    const pair = generateEs256KeyPair();
    const envelope = signPolicyPack(pair.privatePem, payload(), pair.kid);
    const result = verifyPolicyPack(envelope, { publicPem: pair.publicPem });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payloadJson).toBe(envelope.payloadJson);
      expect(result.payload.models.allowCustom).toBe(false);
    }
  });

  it('改 payloadJson 一个字节就验不过 —— 不能写 requirements.toml', () => {
    const pair = generateEs256KeyPair();
    const envelope = signPolicyPack(pair.privatePem, payload(), pair.kid);
    const tampered = {
      ...envelope,
      payloadJson: envelope.payloadJson.replace('ten_1', 'ten_x'),
    };
    expect(verifyPolicyPack(tampered, { publicPem: pair.publicPem })).toEqual({
      ok: false,
      reason: 'bad-sig',
    });
  });

  it('别人的密钥验不过', () => {
    const a = generateEs256KeyPair();
    const b = generateEs256KeyPair();
    const envelope = signPolicyPack(a.privatePem, payload(), a.kid);
    expect(verifyPolicyPack(envelope, { publicPem: b.publicPem }).ok).toBe(false);
  });

  it('encode 再 parse 是恒等（optional 缺席不出现）', () => {
    const p = payload();
    expect(parsePolicyPackPayload(encodePolicyPackPayload(p))).toEqual(p);
    const noGrace = payload();
    expect(
      JSON.parse(encodePolicyPackPayload(noGrace)) as { graceUntil?: unknown },
    ).not.toHaveProperty('graceUntil');
  });
});

describe('有效期', () => {
  it('expiresAt 之前是 valid；宽限内是 expiring；之后是 expired', () => {
    const p = payload({ expiresAt: 1000, graceUntil: 1100 });
    expect(evaluatePolicyPack(p, 900, 0)).toBe('valid');
    expect(evaluatePolicyPack(p, 1050, 0)).toBe('expiring');
    expect(evaluatePolicyPack(p, 1200, 0)).toBe('expired');
  });

  it('没有宽限时一过期就是 expired，不能读成 valid', () => {
    const p = payload({ expiresAt: 1000 });
    expect(evaluatePolicyPack(p, 1001, 0)).toBe('expired');
  });
});

describe('写 requirements.toml', () => {
  it('同时写出 [models] 与模板里的 hooks / 权限 / 开关，不另开通道', () => {
    const toml = policyPackToRequirementsToml(payload());
    expect(toml).toContain('[models]');
    expect(toml).toContain('allow_custom = false');
    expect(toml).toContain('evowork/kimi-k3');
    expect(toml).toContain('allow_managed_hooks_only = true');
    expect(toml).toContain('sharing_enabled = false');
    expect(toml).toContain('slots_enabled = false');
    expect(toml).toContain('audit_upload = true');
    expect(toml).toContain('evowork-full');
  });

  it('超期文案是设计里的那一句，含恢复路径', () => {
    expect(POLICY_EXPIRED_COPY).toBe('安全策略已过期，已切换为只读模式。请连接企业网络以更新。');
  });
});
