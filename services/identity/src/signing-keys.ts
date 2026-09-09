import { generateEs256KeyPair, type Es256KeyPair, type PublicJwk } from '@evowork/account';

import type { SqliteLike } from './db.js';
import { decryptSecret, encryptSecret } from './secret-box.js';

/**
 * 策略包与 JWT 共用一把 ES256 密钥。必须落库：进程一重启就换钥匙，
 * 已经下发的包会全部验不过，企业设备会在「没人改策略」的情况下掉进只读。
 */
export function loadOrCreateSigningKeys(
  db: SqliteLike,
  masterKey: Buffer,
  now: () => number = Date.now,
): Es256KeyPair {
  const row = db
    .prepare(
      `SELECT kid, public_pem, public_jwk_json, private_pem_enc
       FROM signing_keys ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as
    | {
        kid: string;
        public_pem: string;
        public_jwk_json: string;
        private_pem_enc: string;
      }
    | undefined;
  if (row) {
    return {
      kid: row.kid,
      publicPem: row.public_pem,
      privatePem: decryptSecret(masterKey, row.private_pem_enc),
      jwk: JSON.parse(row.public_jwk_json) as PublicJwk,
    };
  }
  const keys = generateEs256KeyPair();
  db.prepare(
    `INSERT INTO signing_keys (kid, public_pem, public_jwk_json, private_pem_enc, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    keys.kid,
    keys.publicPem,
    JSON.stringify(keys.jwk),
    encryptSecret(masterKey, keys.privatePem),
    now(),
  );
  return keys;
}
