import { describe, expect, it } from 'vitest';

import {
  codeChallengeS256,
  generateCodeVerifier,
  verifyCodeChallenge,
} from '../src/pkce.js';

describe('PKCE S256', () => {
  it('同一个 verifier 两次算出同一个 challenge', () => {
    const verifier = generateCodeVerifier();
    expect(codeChallengeS256(verifier)).toBe(codeChallengeS256(verifier));
  });

  it('对的 verifier 过，错一个字符不过', () => {
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
    expect(verifyCodeChallenge(`${verifier}x`.slice(1), challenge)).toBe(false);
  });

  it('verifier 是 unpadded base64url，长度在 RFC 要求的 43–128 之间', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });
});
