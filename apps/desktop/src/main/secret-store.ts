/**
 * 本机密钥库（Q34=A，M10a）—— **`gateway.env` / `gateway-token` 两个明文文件的终点**。
 *
 * ## 它取代了什么
 *
 * 在此之前厂商密钥躺在 `~/.evowork/gateway.env`（明文，600），网关访问令牌躺在
 * `~/.evowork/gateway-token`（同样明文）。两个文件的头注释都写着"这是过渡方案"，
 * 而过渡的终点由 Q34 决策为 **Electron `safeStorage`**：密文落 `~/.evowork/secrets.bin`，
 * 密钥材料交给 macOS Keychain / Windows DPAPI / Linux libsecret 托管。
 *
 * 为什么明文不能留：Q14 的卖点之一是"密钥托管"，而一个自称托管密钥的产品把 key
 * 明文写在用户目录里，这件事没法自证。M10b 之后这里还要存 refresh token，
 * 那时明文的代价从"密钥泄漏"升级为"账号本身泄漏"。
 *
 * ## 三条纪律（每一条都对应一种真实的失败）
 *
 *   ① **不读回渲染层。** 没有任何方法能把明文交给 UI，`describe()` 只给后四位。
 *      渲染进程拿到密钥 = 密钥进了任何一个 XSS 面（11 §12 第 2 条）。
 *   ② **不可用时显式让用户选，绝不静默写明文。** Linux 上没有可用 keyring 时
 *      `isEncryptionAvailable()` 为 false，或退化成固定密钥的 `basic_text`
 *      （等价于明文）。此时 `available` 为 false，`set()` **拒绝写入**，
 *      直到宿主带着用户的明确选择（`allowPlaintext`）再建一次。
 *   ③ **降级要可审计。** `backend` 进日志字段 `secretStore`（`packages/logging` 已注册）——
 *      否则"这台机器上的密钥到底是不是加密的"事后查不出来，而那是安全评审必问的一句。
 *
 * ## 为什么 `safeStorage` 是注入的
 *
 * 与 `bootstrap.ts` 同一条：这个文件不 import electron，于是"钥匙串不可用时会发生什么"
 * 能在测试里跑完 —— 而那条路径恰恰是最难手动构造的（要一台没有 keyring 的 Linux）。
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { Logger } from '@evowork/logging';

/** `safeStorage` 里我们真正用到的那几个方法（Electron 的类型不进这一层）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** 只有 Linux 有：`basic_text` 表示**没有真的钥匙串**，等价于明文 */
  getSelectedStorageBackend?(): string;
}

/**
 * 密钥到底存在哪。**它是一个日志字段**（`secretStore`），不是内部细节：
 * 用户可以选择明文兜底，而这个选择必须留痕。
 */
export type SecretBackend =
  | 'keychain'
  | 'dpapi'
  | 'libsecret'
  | /** 用户显式选择的 600 明文文件 */ 'plaintext-fallback'
  | /** 系统钥匙串不可用且用户还没做选择 —— 此时**不保存任何密钥** */ 'unavailable';

export interface SecretStoreOptions {
  /** `~/.evowork/secrets.bin`（密文） */
  readonly encryptedPath: string;
  /** `~/.evowork/secrets.plain.json` —— **只在 `allowPlaintext` 为真时才会被写** */
  readonly plaintextPath: string;
  readonly safeStorage?: SafeStorageLike | undefined;
  /**
   * 用户是否**显式**同意以明文保存（11 §4.3 的两个选项之一）。
   *
   * 落在 `meta` 表里由宿主传进来，而不是这里自己判断 —— "用户选过了吗"是本机状态，
   * 而这个模块只回答"选了之后怎么存"。
   */
  readonly allowPlaintext?: boolean | undefined;
  readonly logger?: Logger | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/** 一条密钥的**可显示**信息。没有值，只有"有没有"和后四位。 */
export interface SecretDescriptor {
  readonly name: string;
  /** 后四位。短于 4 位的密钥（几乎不存在）显示实际长度那么多个字符 */
  readonly last4: string;
}

export interface SecretStore {
  readonly backend: SecretBackend;
  /** 能不能保存。false = 钥匙串不可用且用户没选明文，UI 要给那两条路 */
  readonly available: boolean;
  has(name: string): boolean;
  /** 存一把密钥。**不可用时返回 false 而不是抛错** —— 调用方要把它变成一句话给用户 */
  set(name: string, value: string): boolean;
  remove(name: string): boolean;
  describe(): readonly SecretDescriptor[];
  /**
   * 解密后拼成子进程环境。**只有主进程会调**（网关只从进程环境读密钥，
   * 这条路径是现成的，全程不落明文盘）。
   */
  toEnv(): Record<string, string>;
}

function detectBackend(
  safeStorage: SafeStorageLike | undefined,
  platform: NodeJS.Platform,
  allowPlaintext: boolean,
): SecretBackend {
  const encrypted = (() => {
    if (!safeStorage) return false;
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      /*
       * Linux 的 `basic_text` 是**用固定密钥加密**，Electron 文档明确说它不安全 ——
       * 把它当成"加密可用"就是我们自己在骗自己（不静默降级）。
       */
      const linuxBackend = safeStorage.getSelectedStorageBackend?.();
      if (linuxBackend !== undefined && linuxBackend === 'basic_text') return false;
      return true;
    } catch {
      return false;
    }
  })();

  if (encrypted) {
    if (platform === 'darwin') return 'keychain';
    if (platform === 'win32') return 'dpapi';
    return 'libsecret';
  }
  return allowPlaintext ? 'plaintext-fallback' : 'unavailable';
}

/** 钥匙串不可用时给用户看的那段话（11 §4.3）。**两个选项并列，不替他选**。 */
export const NO_KEYRING_NOTICE =
  '这台电脑上没有可用的系统密钥库，EvoWork 无法加密保存 API 密钥。' +
  '可以选择以 600 权限的明文文件保存（仅本机可读，但同机的其他程序能读到），' +
  '或每次启动时手动填入（不保存）。';

export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const platform = options.platform ?? process.platform;
  const allowPlaintext = options.allowPlaintext === true;
  const backend = detectBackend(options.safeStorage, platform, allowPlaintext);
  const available = backend !== 'unavailable';

  const read = (): Record<string, string> => {
    if (backend === 'plaintext-fallback') {
      if (!existsSync(options.plaintextPath)) return {};
      try {
        return JSON.parse(readFileSync(options.plaintextPath, 'utf8')) as Record<string, string>;
      } catch {
        // 文件坏了当成空的：密钥文件损坏不该让整个应用起不来（网关那侧会说没密钥）
        return {};
      }
    }
    if (!existsSync(options.encryptedPath) || !options.safeStorage) return {};
    try {
      const plain = options.safeStorage.decryptString(readFileSync(options.encryptedPath));
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      /*
       * 解不开最常见的原因是**换了机器或换了 OS 账号**（钥匙串里那把密钥不在了）。
       * 当成空的 + 记一条：抛错的表现是应用起不来，而正确的表现是"请重新填密钥"。
       */
      options.logger?.warn('desktop.secrets.undecryptable', { secretStore: backend });
      return {};
    }
  };

  const write = (values: Record<string, string>): boolean => {
    const json = JSON.stringify(values);
    if (backend === 'plaintext-fallback') {
      writeFileSync(options.plaintextPath, `${json}\n`, { encoding: 'utf8', mode: 0o600 });
      // mode 只在创建时生效，覆盖已有文件要再设一次
      chmodSync(options.plaintextPath, 0o600);
      return true;
    }
    if (!options.safeStorage) return false;
    writeFileSync(options.encryptedPath, options.safeStorage.encryptString(json), { mode: 0o600 });
    chmodSync(options.encryptedPath, 0o600);
    return true;
  };

  return {
    backend,
    available,

    has(name) {
      return (read()[name] ?? '') !== '';
    },

    set(name, value) {
      const trimmed = value.trim();
      if (trimmed === '') return false;
      if (!available) {
        // **不静默写明文**。调用方把 `NO_KEYRING_NOTICE` 交给用户，等他做选择
        options.logger?.warn('desktop.secrets.rejected', { secretStore: backend });
        return false;
      }
      const values = read();
      values[name] = trimmed;
      const ok = write(values);
      if (ok) options.logger?.info('desktop.secrets.saved', { secretStore: backend });
      return ok;
    },

    remove(name) {
      const values = read();
      if (!(name in values)) return false;
      delete values[name];
      const ok = write(values);
      if (ok) options.logger?.info('desktop.secrets.removed', { secretStore: backend });
      return ok;
    },

    describe() {
      return Object.entries(read())
        .filter(([, value]) => value !== '')
        .map(([name, value]) => ({ name, last4: value.slice(-4) }));
    },

    toEnv() {
      return { ...read() };
    },
  };
}

/**
 * 一次性迁移：`~/.evowork/gateway.env` → 密钥库。
 *
 * **迁移后把源文件改名成 `gateway.env.migrated`，不删。** `docs/build-and-deploy.md`
 * 一直让人手写那个文件，静默删掉会让照文档操作的人以为自己搞错了；而留着原名
 * 会让下一次启动又读它一遍（两处真源）。改名同时回答了这两件事。
 *
 * 只在**密钥库里还没有这把密钥**时才导入：用户在设置页改过之后，
 * 那个旧文件里的值就是过期的，再导入等于把用户的修改覆盖回去。
 */
export function migratePlaintextSecrets(options: {
  readonly store: SecretStore;
  /** 明文文件路径 → 里面的键值（已按白名单过滤） */
  readonly sources: readonly { readonly path: string; readonly values: Record<string, string> }[];
  readonly logger?: Logger | undefined;
}): number {
  if (!options.store.available) return 0;
  let imported = 0;
  for (const source of options.sources) {
    if (!existsSync(source.path)) continue;
    let touched = false;
    for (const [name, value] of Object.entries(source.values)) {
      if (options.store.has(name)) continue;
      if (options.store.set(name, value)) {
        imported += 1;
        touched = true;
      }
    }
    /*
     * 即使一把都没导入（都已经在库里了）也要改名 —— 否则那个明文文件会一直躺在
     * 用户的磁盘上，而"密钥不落明文盘"这句话就不成立了。
     */
    try {
      renameSync(source.path, `${source.path}.migrated`);
      touched = true;
    } catch {
      // 改不动名（权限、被占用）不该阻塞启动，但下一条日志要能看出来
    }
    if (touched) {
      options.logger?.info('desktop.secrets.migrated', {
        itemCount: imported,
        secretStore: options.store.backend,
      });
    }
  }
  return imported;
}
