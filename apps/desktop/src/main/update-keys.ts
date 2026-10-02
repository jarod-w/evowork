/**
 * 客户端信任的更新清单公钥（在线升级提案 §4 B3）。
 *
 * 2026-10-02 定：私钥**只在发版机上**，这里内嵌**两把**公钥 ——
 *
 *   · `daily`  —— 日常签名用。私钥在发版机的登录钥匙串里
 *   · `backup` —— 离线备用。私钥单独离线保管（如加密 U 盘），只在日常那把丢失或泄露时启用。
 *                 没有它的话，日常那把一丢，已装的客户端就再也验不过任何新版本，
 *                 用户只能手动重装一个带新公钥的版本
 *
 * 2026-10-02 在发版机上生成（发版的人授权在那台机器上直接操作；目前只有一个人发版）：
 *
 * ```bash
 * node scripts/update-signing.mjs keygen --kid evowork-update-1                    # 日常，私钥进登录钥匙串
 * node scripts/update-signing.mjs keygen --kid evowork-update-backup-1 --role backup --out <离线位置>/backup.pem
 * ```
 *
 * **换 key 或加 key 时**：新的公钥先随一个版本发出去，等它装到大多数机器上之后，才开始用新私钥签名。
 * 顺序反过来的话，没升级的客户端会报 unknown-key，而它们正是需要更新的那批。
 * 这个数组空着时「检查更新」如实报「没有可用的更新签名公钥」，不放行任何清单；
 * `scripts/publish-release.mjs` 也会拒绝发布。
 */
import type { UpdatePublicKey } from './update-manifest.js';

export const UPDATE_PUBLIC_KEYS: readonly UpdatePublicKey[] = [
  {
    kid: 'evowork-update-1',
    role: 'daily',
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'LLISJfIXvmlYrradQUi-1IBJDhnZISGHcQSrY-1Bn1Y',
      y: '0Ii9AQzLgrCivXwuxsvYXJkwlHVL-H6Tm9mJZdeYceo',
    },
  },
  {
    kid: 'evowork-update-backup-1',
    role: 'backup',
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'Ml-klEdxbA9LGM0uPiV_4oz7MVJhGLbG_eoou04uKsw',
      y: 'Ly4HXaw9XQe0xIV1YFpKSormsTWjvvpnRRCom8IrdXc',
    },
  },
];
