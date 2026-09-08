/**
 * 密钥库（Q34=A，M10a）—— `gateway.env` / `gateway-token` 两个明文文件的终点。
 *
 * 这组断言里有两条是**安全属性**，不是功能：
 *   · 钥匙串不可用时**不写明文**（除非用户显式选了那条路）；
 *   · 没有任何方法能把明文交回调用方之外的地方 —— `describe()` 只给后四位。
 *
 * 剩下的守的是"升级不能让用户静默失去密钥"这件事（迁移 + 改名）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSecretStore,
  migratePlaintextSecrets,
  NO_KEYRING_NOTICE,
  type SafeStorageLike,
} from '../src/main/secret-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 假钥匙串。**不是明文存**：加密成 base64 并加一个前缀，
 * 这样"密文文件里不该出现密钥原文"这条断言是真的在验加密，而不是在验 JSON.stringify。
 */
function fakeSafeStorage(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decryptString: (buf) => {
      const text = buf.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('不是这台机器加密的');
      return Buffer.from(text.slice('enc:'.length), 'base64').toString('utf8');
    },
    ...over,
  };
}

function store(over: Partial<Parameters<typeof createSecretStore>[0]> = {}) {
  return createSecretStore({
    encryptedPath: join(dir, 'secrets.bin'),
    plaintextPath: join(dir, 'secrets.plain.json'),
    safeStorage: fakeSafeStorage(),
    platform: 'darwin',
    ...over,
  });
}

describe('钥匙串可用时', () => {
  it('存得进、取得出，而**密文文件里没有密钥原文**', () => {
    const s = store();
    expect(s.backend).toBe('keychain');
    expect(s.set('DEEPSEEK_API_KEY', 'sk-real-secret-3f9a')).toBe(true);

    const raw = readFileSync(join(dir, 'secrets.bin'), 'utf8');
    expect(raw).not.toContain('sk-real-secret-3f9a');
    // 宿主自己能解开（它要把密钥灌进网关子进程的环境）
    expect(s.toEnv().DEEPSEEK_API_KEY).toBe('sk-real-secret-3f9a');
  });

  it('`describe()` **只给后四位** —— 这是给渲染层看的，没有读回明文的路', () => {
    const s = store();
    s.set('DEEPSEEK_API_KEY', 'sk-real-secret-3f9a');
    expect(s.describe()).toEqual([{ name: 'DEEPSEEK_API_KEY', last4: '3f9a' }]);
    // 类型上就没有"读回明文"的方法。这条断言是给读代码的人看的：
    // 想加一个 `get(name)` 会同时让这一行变红
    expect(Object.keys(s)).not.toContain('get');
  });

  it('平台决定 backend 的名字（它要进日志，用来回答"这台机器上密钥怎么存的"）', () => {
    expect(store({ platform: 'win32' }).backend).toBe('dpapi');
    expect(store({ platform: 'linux' }).backend).toBe('libsecret');
  });

  it('清除之后就真的没有了（「清除」是显式动作，不是把输入框清空）', () => {
    const s = store();
    s.set('ZHIPU_API_KEY', 'sk-zhipu');
    expect(s.remove('ZHIPU_API_KEY')).toBe(true);
    expect(s.has('ZHIPU_API_KEY')).toBe(false);
    expect(s.remove('ZHIPU_API_KEY')).toBe(false);
  });

  it('解不开时当成空的 + 不抛 —— 换机器/换 OS 账号时应用还要能起来', () => {
    writeFileSync(join(dir, 'secrets.bin'), '别人的密文');
    const s = store();
    expect(s.describe()).toEqual([]);
    expect(s.toEnv()).toEqual({});
  });
});

describe('钥匙串不可用时（Linux 无 keyring / 没注入 safeStorage）', () => {
  it('**拒绝保存**，且不产生任何文件 —— 不静默写明文', () => {
    const s = store({ safeStorage: undefined });
    expect(s.backend).toBe('unavailable');
    expect(s.available).toBe(false);
    expect(s.set('DEEPSEEK_API_KEY', 'sk-x')).toBe(false);
    expect(existsSync(join(dir, 'secrets.bin'))).toBe(false);
    expect(existsSync(join(dir, 'secrets.plain.json'))).toBe(false);
  });

  /*
   * Linux 的 `basic_text` 是**用固定密钥加密**，Electron 文档明确说它不安全。
   * 把它当成"加密可用"就是我们自己骗自己（不静默降级）。
   */
  it('`basic_text` 后端算不可用 —— 固定密钥等价于明文', () => {
    const s = store({
      platform: 'linux',
      safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
    });
    expect(s.backend).toBe('unavailable');
  });

  it('文案把两个选项并列摆出来，**不替用户选**（11 §4.3）', () => {
    expect(NO_KEYRING_NOTICE).toContain('明文文件保存');
    expect(NO_KEYRING_NOTICE).toContain('手动填入');
  });

  it('用户显式选了明文之后才写文件，且 backend 变成可审计的那个值', () => {
    const s = store({ safeStorage: undefined, allowPlaintext: true });
    expect(s.backend).toBe('plaintext-fallback');
    expect(s.set('DEEPSEEK_API_KEY', 'sk-plain')).toBe(true);
    expect(readFileSync(join(dir, 'secrets.plain.json'), 'utf8')).toContain('sk-plain');
    expect(s.toEnv().DEEPSEEK_API_KEY).toBe('sk-plain');
  });
});

describe('一次性迁移：明文文件 → 密钥库', () => {
  it('导入之后把源文件改名成 `.migrated`，不删', () => {
    const envPath = join(dir, 'gateway.env');
    writeFileSync(envPath, 'DEEPSEEK_API_KEY=sk-from-file\n');
    const s = store();

    const imported = migratePlaintextSecrets({
      store: s,
      sources: [{ path: envPath, values: { DEEPSEEK_API_KEY: 'sk-from-file' } }],
    });

    expect(imported).toBe(1);
    expect(s.toEnv().DEEPSEEK_API_KEY).toBe('sk-from-file');
    // **不删**：docs/build-and-deploy.md 一直让人手写这个文件，静默删掉会让人以为自己搞错了
    expect(existsSync(envPath)).toBe(false);
    expect(existsSync(`${envPath}.migrated`)).toBe(true);
  });

  it('库里已经有那把密钥时不覆盖 —— 用户在设置页改过的值才是新的', () => {
    const envPath = join(dir, 'gateway.env');
    writeFileSync(envPath, 'DEEPSEEK_API_KEY=sk-old\n');
    const s = store();
    s.set('DEEPSEEK_API_KEY', 'sk-new');

    migratePlaintextSecrets({
      store: s,
      sources: [{ path: envPath, values: { DEEPSEEK_API_KEY: 'sk-old' } }],
    });
    expect(s.toEnv().DEEPSEEK_API_KEY).toBe('sk-new');
    // 一把都没导入也要改名：否则那个明文文件会一直躺在磁盘上
    expect(existsSync(`${envPath}.migrated`)).toBe(true);
  });

  it('密钥库不可用时**什么都不做**（不改名、不丢弃）—— 那个文件还是用户唯一的密钥来源', () => {
    const envPath = join(dir, 'gateway.env');
    writeFileSync(envPath, 'DEEPSEEK_API_KEY=sk-from-file\n');
    const s = store({ safeStorage: undefined });

    expect(
      migratePlaintextSecrets({
        store: s,
        sources: [{ path: envPath, values: { DEEPSEEK_API_KEY: 'sk-from-file' } }],
      }),
    ).toBe(0);
    // 改了名就等于把老机器的密钥弄丢了（而它连保存都做不到）
    expect(existsSync(envPath)).toBe(true);
  });
});
