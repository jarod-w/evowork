import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyPolicyPack } from '@evowork/account';
import { describe, expect, it } from 'vitest';

import { openIdentityDb } from '../src/db.js';
import { memoryMailer } from '../src/mailer.js';
import { TEST_ARGON } from '../src/password.js';
import { parseMasterKey } from '../src/secret-box.js';
import { createIdentity } from '../src/service.js';
import { loadOrCreateSigningKeys } from '../src/signing-keys.js';

const MASTER = parseMasterKey('ab'.repeat(32));

describe('签发密钥跨重启', () => {
  it('第二次打开同一库仍能验第一次签的策略包', () => {
    const dir = mkdtempSync(join(tmpdir(), 'id-keys-'));
    const path = join(dir, 'id.sqlite');
    const db1 = openIdentityDb(path);
    const keys1 = loadOrCreateSigningKeys(db1, MASTER, () => 1_700_000_000_000);
    const identity1 = createIdentity({
      db: db1,
      keys: keys1,
      masterKey: MASTER,
      mailer: memoryMailer(),
      argon: TEST_ARGON,
      publicOrigin: 'http://127.0.0.1:8788',
      now: () => 1_700_000_000_000,
    });
    identity1.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity1.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    const envelope = identity1.issuePolicyPack(admin.userId, {
      expiresInDays: 14,
      allowCustom: false,
    });

    const db2 = openIdentityDb(path);
    const keys2 = loadOrCreateSigningKeys(db2, MASTER);
    expect(keys2.kid).toBe(keys1.kid);
    expect(keys2.publicPem).toBe(keys1.publicPem);
    expect(verifyPolicyPack(envelope, { publicPem: keys2.publicPem }).ok).toBe(true);
  });
});
