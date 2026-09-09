/**
 * 「模型接入」的本机状态机（M10a = 11 §4 的全部）。
 *
 * **这里最要紧的一条是"密钥只朝一个方向走"**（11 §12 第 2 条）：
 * 渲染层收到的完整 payload 里不许出现密钥。它做错的后果不是功能问题 ——
 * 密钥进渲染进程等于进了任何一个 XSS 面，而"某处忘了过滤"是会真实发生的。
 * 所以这条断言的写法是**把整个视图序列化后搜密钥原文**，不是逐字段检查。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACCESS_JWT_ENV,
  CUSTOM_MODELS_ENV,
  MODEL_POLICY_ENV,
  UPSTREAM_BASE_URL_ENV,
} from '@evowork/gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createModelAccess, parseModelPolicyToml } from '../src/main/model-access.js';
import type { SafeStorageLike } from '../src/main/secret-store.js';
import type { ModelCatalogResult } from '../src/shared/ipc.js';

const SECRET = 'sk-super-secret-value-3f9a';
const EMPTY_CATALOG: ModelCatalogResult = { models: [] };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-access-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function safeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decryptString: (buf) =>
      Buffer.from(buf.toString('utf8').slice('enc:'.length), 'base64').toString('utf8'),
  };
}

function access(
  over: Partial<Parameters<typeof createModelAccess>[0]> = {},
  flags: Record<string, string> = {},
) {
  return createModelAccess({
    paths: {
      home: dir,
      kernelHome: join(dir, 'kernel'),
      secrets: join(dir, 'secrets.bin'),
      secretsPlain: join(dir, 'secrets.plain.json'),
      appConfig: join(dir, 'app.toml'),
      modelsFile: join(dir, 'models.toml'),
      gatewayEnv: join(dir, 'gateway.env'),
      gatewayToken: join(dir, 'gateway-token'),
      requirements: join(dir, 'requirements.toml'),
    },
    safeStorage: safeStorage(),
    baseEnv: {},
    kernelBaseUrl: 'http://127.0.0.1:8787/v1',
    readFlag: (key) => flags[key],
    writeFlag: (key, value) => {
      flags[key] = value;
    },
    ...over,
  });
}

describe('密钥只朝一个方向走（11 §12 第 2 条）', () => {
  it('保存之后，**整个视图序列化后搜不到密钥原文**，只有后四位', () => {
    const m = access();
    expect(m.saveProviderKey({ providerId: 'deepseek', apiKey: SECRET })).toBe(true);

    const serialized = JSON.stringify(m.view(EMPTY_CATALOG));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('sk-super');
    expect(serialized).toContain('3f9a');
  });

  it('密钥进的是网关子进程的**进程环境**（那条路径现成，且不落明文盘）', () => {
    const m = access();
    m.saveProviderKey({ providerId: 'moonshot', apiKey: SECRET });
    expect(m.env().MOONSHOT_API_KEY).toBe(SECRET);
    // 落盘的是密文
    expect(readFileSync(join(dir, 'secrets.bin'), 'utf8')).not.toContain(SECRET);
  });

  it('自定义模型的密钥同样不回读：视图里只有 endpoint 与后四位', () => {
    const m = access();
    expect(
      m.addCustomModel({
        id: 'my/llm',
        provider: 'private',
        upstreamModel: 'qwen3-max',
        baseUrl: 'https://example.com/v1',
        apiKey: SECRET,
      }),
    ).toBeUndefined();

    const view = m.view(EMPTY_CATALOG);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.customModels[0]?.baseUrl).toBe('https://example.com/v1');
    expect(view.customModels[0]?.keySaved).toBe(true);
    // `models.toml` 里也没有密钥 —— 那个文件只有元数据
    expect(readFileSync(join(dir, 'models.toml'), 'utf8')).not.toContain(SECRET);
  });
});

describe('自定义模型（第③层）', () => {
  it('不选协议适配类型时**拒绝**，理由是一句能直接显示的话', () => {
    const refusal = access().addCustomModel({
      id: 'my/llm',
      provider: '',
      upstreamModel: 'x',
      baseUrl: 'https://example.com/v1',
      apiKey: SECRET,
    });
    expect(refusal).toContain('协议适配类型');
  });

  it('元数据与密钥一起进环境：JSON 里是变量名，密钥在它自己的变量里', () => {
    const m = access();
    m.addCustomModel({
      id: 'my/llm',
      provider: 'private',
      upstreamModel: 'qwen3-max',
      baseUrl: 'https://example.com/v1',
      apiKey: SECRET,
    });
    const env = m.env();
    const specs = JSON.parse(env[CUSTOM_MODELS_ENV] as string) as { keyEnv: string }[];
    expect(specs).toHaveLength(1);
    expect(env[CUSTOM_MODELS_ENV]).not.toContain(SECRET);
    expect(env[specs[0]?.keyEnv as string]).toBe(SECRET);
  });

  it('同 id 加两次会被拒（不是静默覆盖掉第一条）', () => {
    const m = access();
    const input = {
      id: 'my/llm',
      provider: 'private',
      upstreamModel: 'x',
      baseUrl: 'https://example.com/v1',
      apiKey: SECRET,
    };
    expect(m.addCustomModel(input)).toBeUndefined();
    expect(m.addCustomModel(input)).toContain('已经有一个');
  });

  it('删除时**密钥跟着删** —— 留着它会让下一条模型静默用上旧密钥', () => {
    const m = access();
    m.addCustomModel({
      id: 'my/llm',
      provider: 'private',
      upstreamModel: 'x',
      baseUrl: 'https://example.com/v1',
      apiKey: SECRET,
    });
    const keyEnv = (JSON.parse(m.env()[CUSTOM_MODELS_ENV] as string) as { keyEnv: string }[])[0]
      ?.keyEnv as string;
    expect(m.env()[keyEnv]).toBe(SECRET);

    expect(m.removeCustomModel('my/llm')).toBe(true);
    expect(m.env()[keyEnv]).toBeUndefined();
    expect(m.view(EMPTY_CATALOG).customModels).toEqual([]);
  });

  it('密钥库不可用时不假装存下了 —— 返回那段"你来选"的说明', () => {
    const m = access({ safeStorage: undefined });
    const refusal = m.addCustomModel({
      id: 'my/llm',
      provider: 'private',
      upstreamModel: 'x',
      baseUrl: 'https://example.com/v1',
      apiKey: SECRET,
    });
    expect(refusal).toContain('系统密钥库');
    expect(existsSync(join(dir, 'models.toml'))).toBe(false);
  });
});

describe('第②层：企业策略复用 requirements.toml 这条已有通道', () => {
  it('解析 `[models]` 段的三个键', () => {
    const policy = parseModelPolicyToml(
      '[models]\ndisabled = ["evowork/glm-flash", "x/y"]\nallow_custom = false\nreason = "合规未批"\n',
    );
    expect(policy.disabledModelIds).toEqual(['evowork/glm-flash', 'x/y']);
    expect(policy.allowCustomModels).toBe(false);
    expect(policy.reason).toBe('合规未批');
  });

  it('没有 `[models]` 段 = 不锁（个人机器必须能用 BYOK，Q30=A）', () => {
    expect(parseModelPolicyToml('[hooks]\nx = 1\n').allowCustomModels).toBe(true);
  });

  it('锁了之后添加自定义模型被拒，且**说清是组织策略**而不是"你没配密钥"', () => {
    writeFileSync(join(dir, 'requirements.toml'), '[models]\nallow_custom = false\n');
    const m = access();
    const refusal = m.addCustomModel({
      id: 'my/llm',
      provider: 'private',
      upstreamModel: 'x',
      baseUrl: 'https://example.com/v1',
      apiKey: SECRET,
    });
    expect(refusal).toContain('组织');
    // 视图里也要有原因：否则用户会去翻一个已经被锁掉的入口
    const view = m.view(EMPTY_CATALOG);
    expect(view.allowCustomModels).toBe(false);
    expect(view.lockedReason).toBeDefined();
  });

  it('策略跟着进网关的环境（网关那一侧才是真正的拦截点）', () => {
    writeFileSync(join(dir, 'requirements.toml'), '[models]\ndisabled = ["evowork/kimi-k3"]\n');
    const policy = JSON.parse(access().env()[MODEL_POLICY_ENV] as string) as {
      disabledModelIds: string[];
    };
    expect(policy.disabledModelIds).toEqual(['evowork/kimi-k3']);
  });
});

describe('拓扑与令牌（D11）', () => {
  it('`local`：没有令牌就现签一个，并存进密钥库（用户不该知道有这么个东西）', () => {
    const m = access();
    expect(m.runsLocalGateway).toBe(true);
    const token = m.token();
    expect(token).toBeTruthy();
    // 再问一次是同一个（不是每次都签一把新的 —— 那样内核与网关会各拿一半）
    expect(m.token()).toBe(token);
    expect(m.env().EVOWORK_GATEWAY_TOKEN).toBe(token);
  });

  it('`private`：本机网关仍然起（D11：内核永远打 loopback），并自签本机令牌', () => {
    writeFileSync(
      join(dir, 'app.toml'),
      '[gateway]\nmode = "private"\nupstream_base_url = "https://gw.corp.example/v1"\n',
    );
    const m = access();
    expect(m.runsLocalGateway).toBe(true);
    expect(m.upstreamBaseUrl).toBe('https://gw.corp.example/v1');
    expect(m.token()).toBeTruthy();
    const env = m.env();
    expect(env[UPSTREAM_BASE_URL_ENV]).toBe('https://gw.corp.example/v1');
    expect(env[ACCESS_JWT_ENV]).toBe(m.token());
    expect(env.EVOWORK_AUTH_MODE).toBeUndefined();
  });

  it('`hosted`：未登录不把我们的云写进网关环境（11 §12 第 14 条）', () => {
    writeFileSync(join(dir, 'app.toml'), '[gateway]\nmode = "hosted"\n');
    const m = access();
    expect(m.runsLocalGateway).toBe(true);
    const env = m.env();
    expect(env[UPSTREAM_BASE_URL_ENV]).toBeUndefined();
    expect(env[ACCESS_JWT_ENV]).toBeUndefined();
    expect(env.EVOWORK_AUTH_MODE).toBeUndefined();
  });

  it('进程环境里的令牌优先（开发时从终端起、企业用 launchd 注入）', () => {
    const m = access({ baseEnv: { EVOWORK_GATEWAY_TOKEN: 'from-env' } });
    expect(m.token()).toBe('from-env');
  });
});

describe('升级路径：老机器不能静默失去密钥', () => {
  it('钥匙串可用 → 迁移 `gateway.env` 并改名，密钥照样进环境', () => {
    writeFileSync(join(dir, 'gateway.env'), 'DEEPSEEK_API_KEY=sk-from-file\n');
    const m = access();
    expect(m.env().DEEPSEEK_API_KEY).toBe('sk-from-file');
    expect(existsSync(join(dir, 'gateway.env.migrated'))).toBe(true);
    expect(m.view(EMPTY_CATALOG).providers[0]?.saved).toBe(true);
  });

  /*
   * 这条是被 `service-host.test.ts` 那条老断言逼出来的：迁移要求密钥库可用，
   * 而没有 keyring 的机器上它不可用 —— 于是升级之后那台机器会静默失去所有密钥，
   * 用户看到"一家密钥都没配"，而他的 `gateway.env` 明明还在那儿。
   */
  it('钥匙串不可用 → **继续读旧文件**、不改名，并在视图里说清现在存不了', () => {
    writeFileSync(join(dir, 'gateway.env'), 'DEEPSEEK_API_KEY=sk-from-file\n');
    writeFileSync(join(dir, 'gateway-token'), 'legacy-token\n');
    const m = access({ safeStorage: undefined });

    expect(m.env().DEEPSEEK_API_KEY).toBe('sk-from-file');
    expect(m.token()).toBe('legacy-token');
    expect(existsSync(join(dir, 'gateway.env'))).toBe(true);
    const view = m.view(EMPTY_CATALOG);
    // 密钥仍然可用，但"现在保存不了"必须说出来（不静默降级）
    expect(view.providers[0]?.saved).toBe(true);
    expect(view.secretNotice).toContain('系统密钥库');
  });

  it('用户选了明文兜底之后，backend 立刻变（不用等下次启动）', () => {
    const flags: Record<string, string> = {};
    const m = access({ safeStorage: undefined }, flags);
    expect(m.secretBackend).toBe('unavailable');
    m.setPlaintextFallback(true);
    expect(m.secretBackend).toBe('plaintext-fallback');
    expect(m.saveProviderKey({ providerId: 'zhipu', apiKey: SECRET })).toBe(true);
  });
});

describe('视图', () => {
  it('三家内置厂商都列出来（没配的也列，否则用户不知道自己能配什么）', () => {
    const view = access().view(EMPTY_CATALOG);
    expect(view.providers.map((p) => p.id)).toEqual(['deepseek', 'moonshot', 'zhipu']);
    expect(view.providers.every((p) => !p.saved)).toBe(true);
  });

  it('model-access 这一层不感知账号；signedIn 由宿主叠 account.decorate()', () => {
    expect(access().view(EMPTY_CATALOG).signedIn).toBe(false);
  });

  it('网关目录读不到时把原因带上（与 Composer 顶部那条 danger 是同一句话）', () => {
    const view = access().view({
      models: [],
      unavailable: '连不上模型网关',
      reason: 'unreachable',
    });
    expect(view.catalogUnavailable).toBe('连不上模型网关');
  });
});
