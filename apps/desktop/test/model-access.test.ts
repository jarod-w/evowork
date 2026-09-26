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

import {
  createModelAccess,
  parseModelPolicyToml,
  parseOpenAiModelsList,
  probeModel,
  probeVerdictFromLine,
} from '../src/main/model-access.js';
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

/**
 * 2026-09-26 的缺陷：添加模型的对话框**没有能力位的输入项**（11 §4.4 只问供应商 /
 * 密钥 / 模型名 / endpoint），于是每条自定义模型都带着"三个高级能力全 false"存下来。
 * 用户加了 `moonshot/kimi-k3` 与 `deepseek/deepseek-flash`，两条都不会读图 ——
 * 而 kimi-k3 能读图是我们自己实测出来的结论。
 *
 * 下面四条守的是：**能力位认得出来就别让保守默认盖掉，并且已经存坏的那些要自己好**。
 */
describe('自定义模型的能力位来自能力表（known-models）', () => {
  function add(over: { provider: string; upstreamModel: string }) {
    const m = access();
    expect(
      m.addCustomModel({
        id: `${over.provider}/${over.upstreamModel}`,
        provider: over.provider,
        upstreamModel: over.upstreamModel,
        baseUrl: 'https://example.com/v1',
        apiKey: SECRET,
      }),
    ).toBeUndefined();
    return JSON.parse(m.env()[CUSTOM_MODELS_ENV] as string) as {
      capabilities: { imageInput: boolean; reasoning: boolean };
    }[];
  }

  it('加一条 kimi-k3 就能读图 —— 同一个型号不该因为走哪一层而失忆', () => {
    expect(
      add({ provider: 'moonshot', upstreamModel: 'kimi-k3' })[0]?.capabilities.imageInput,
    ).toBe(true);
  });

  it('加一条 deepseek-flash 也能读图（厂商视觉指南）', () => {
    const spec = add({ provider: 'deepseek', upstreamModel: 'deepseek-flash' })[0];
    expect(spec?.capabilities.imageInput).toBe(true);
    expect(spec?.capabilities.reasoning).toBe(true);
  });

  it('表外的型号仍然走保守默认（我们对它确实一无所知）', () => {
    expect(
      add({ provider: 'private', upstreamModel: 'qwen3-max' })[0]?.capabilities.imageInput,
    ).toBe(false);
  });

  it('**已经存坏的 models.toml 自己会好**：用户不会知道要删了重加', () => {
    // 缺陷发生在先 —— 用户机器上躺着的就是这一份
    writeFileSync(
      join(dir, 'models.toml'),
      [
        '[[models]]',
        'id = "moonshot/kimi-k3"',
        'display_name = "kimi-k3"',
        'provider = "moonshot"',
        'upstream_model = "kimi-k3"',
        'base_url = "https://api.moonshot.cn/v1"',
        'key_env = "EVOWORK_CUSTOM_KEY_1"',
        'reasoning = false',
        'image_input = false',
        'parallel_tool_calls = false',
        'prompt_cache = false',
        'max_context_tokens = 32000',
        '',
      ].join('\n'),
      'utf8',
    );
    const specs = JSON.parse(access().env()[CUSTOM_MODELS_ENV] as string) as {
      capabilities: { imageInput: boolean; maxContextTokens: number };
    }[];
    expect(specs[0]?.capabilities.imageInput).toBe(true);
    expect(specs[0]?.capabilities.maxContextTokens).toBe(256_000);
  });

  it('把型号改成另一个就重算能力位，不沿用上一条的', () => {
    const m = access();
    m.addCustomModel({
      id: 'deepseek/deepseek-flash',
      provider: 'deepseek',
      upstreamModel: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: SECRET,
    });
    // 改回那个"收下图却看不见"的老型号：徽标必须跟着变，否则用户发了图只会得到"我没看到"
    expect(
      m.updateCustomModel({
        previousId: 'deepseek/deepseek-flash',
        id: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        upstreamModel: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
      }),
    ).toBeUndefined();
    const specs = JSON.parse(m.env()[CUSTOM_MODELS_ENV] as string) as {
      capabilities: { imageInput: boolean };
    }[];
    expect(specs[0]?.capabilities.imageInput).toBe(false);
  });
});

describe('改一条自定义模型（设置页的铅笔，11 §4.4）', () => {
  const BASE = {
    id: 'my/llm',
    provider: 'private' as const,
    upstreamModel: 'qwen3-max',
    baseUrl: 'https://example.com/v1',
    apiKey: SECRET,
  };

  /** 那一条模型的密钥槽位（`env()` 里的变量名）。改名之后它必须还是同一个 */
  function keyEnvOf(m: ReturnType<typeof access>): string {
    return (JSON.parse(m.env()[CUSTOM_MODELS_ENV] as string) as { keyEnv: string }[])[0]
      ?.keyEnv as string;
  }

  it('改地址时**不要求重填密钥**，而且那把密钥还在（原地改，不是删了再加）', () => {
    const m = access();
    m.addCustomModel(BASE);
    const keyEnv = keyEnvOf(m);

    expect(
      m.updateCustomModel({
        previousId: 'my/llm',
        id: 'my/llm',
        provider: 'private',
        upstreamModel: 'qwen3-max',
        baseUrl: 'https://proxy.internal/v1',
      }),
    ).toBeUndefined();
    // 槽位没换 + 密钥没丢：删了再加会让"改个地址"变成"模型没密钥了"
    expect(keyEnvOf(m)).toBe(keyEnv);
    expect(m.env()[keyEnv]).toBe(SECRET);
    expect(m.view(EMPTY_CATALOG).customModels[0]?.baseUrl).toBe('https://proxy.internal/v1');
  });

  it('改名 = 改 id，仍然只有一条（不会留下改名前那一条）', () => {
    const m = access();
    m.addCustomModel(BASE);
    expect(
      m.updateCustomModel({
        previousId: 'my/llm',
        id: 'private/qwen3-plus',
        provider: 'private',
        upstreamModel: 'qwen3-plus',
        baseUrl: BASE.baseUrl,
      }),
    ).toBeUndefined();
    const models = m.view(EMPTY_CATALOG).customModels;
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('private/qwen3-plus');
  });

  it('改成一个已经存在的 id 会被拒（同 addCustomModel：不静默覆盖别人）', () => {
    const m = access();
    m.addCustomModel(BASE);
    m.addCustomModel({ ...BASE, id: 'my/other' });
    expect(
      m.updateCustomModel({
        previousId: 'my/other',
        id: 'my/llm',
        provider: 'private',
        upstreamModel: 'x',
        baseUrl: BASE.baseUrl,
      }),
    ).toContain('已经有一个');
  });

  it('给了新密钥就整条覆盖，**旧的读不回来了**', () => {
    const m = access();
    m.addCustomModel(BASE);
    m.updateCustomModel({
      previousId: 'my/llm',
      id: 'my/llm',
      provider: 'private',
      upstreamModel: BASE.upstreamModel,
      baseUrl: BASE.baseUrl,
      apiKey: 'sk-rotated-0000',
    });
    expect(m.env()[keyEnvOf(m)]).toBe('sk-rotated-0000');
    expect(JSON.stringify(m.view(EMPTY_CATALOG))).not.toContain('sk-rotated-0000');
  });

  it('那一条本来就没存上密钥、这次又留空 → 拒绝，而不是存出一条发过去 401 的模型', () => {
    const m = access();
    m.addCustomModel(BASE);
    // 模拟"密钥丢了"（换了 OS 账号、secrets.bin 没了）：直接把文件里那条留着、库清空
    const keyEnv = keyEnvOf(m);
    writeFileSync(join(dir, 'secrets.bin'), '', 'utf8');
    const reopened = access();
    expect(reopened.env()[keyEnv]).toBeUndefined();
    expect(
      reopened.updateCustomModel({
        previousId: 'my/llm',
        id: 'my/llm',
        provider: 'private',
        upstreamModel: BASE.upstreamModel,
        baseUrl: BASE.baseUrl,
      }),
    ).toContain('API 密钥');
  });

  it('那一条已经不在了（另一个窗口删掉了）→ 说清要刷新，不新建一条', () => {
    const m = access();
    expect(
      m.updateCustomModel({
        previousId: 'gone/model',
        id: 'gone/model',
        provider: 'private',
        upstreamModel: 'x',
        baseUrl: BASE.baseUrl,
      }),
    ).toContain('已经不在了');
    expect(m.view(EMPTY_CATALOG).customModels).toEqual([]);
  });
});

describe('保存之前的「测试连接」（11 §4.4）', () => {
  const BASE = {
    id: 'my/llm',
    provider: 'private' as const,
    upstreamModel: 'qwen3-max',
    baseUrl: 'https://example.com/v1',
    apiKey: SECRET,
  };

  it('打的是上游的 GET `/models`，**不经本机网关** —— 这条模型还没进网关的环境', async () => {
    const calls: { url: string; method: string | undefined; auth: string | undefined }[] = [];
    const m = access({
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          method: init?.method,
          auth: headers.get('authorization') ?? undefined,
        });
        return new Response(JSON.stringify({ data: [{ id: 'qwen3-max' }, { id: 'qwen3-plus' }] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });

    const result = await m.testCustomModel({
      provider: 'private',
      baseUrl: 'https://example.com/v1',
      apiKey: SECRET,
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen3-max', 'qwen3-plus']);
    expect(calls[0]?.url).toBe('https://example.com/v1/models');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.auth).toBe(`Bearer ${SECRET}`);
  });

  it('编辑时留空密钥 → 用那条已存模型的那把（明文只在主进程里出现）', async () => {
    let sent: string | undefined;
    const m = access({
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent = new Headers(init?.headers).get('authorization') ?? undefined;
        return new Response(JSON.stringify({ data: [{ id: 'qwen3-max' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    m.addCustomModel(BASE);

    await m.testCustomModel({
      provider: 'private',
      baseUrl: BASE.baseUrl,
      modelId: 'my/llm',
    });
    expect(sent).toBe(`Bearer ${SECRET}`);
  });

  it('401 与 404 说的是两件不同的事（密钥不对 vs 没有 /models 列表）', async () => {
    const status = { code: 401 };
    const m = access({
      fetchFn: (async () =>
        new Response('{"error":"内部诊断信息"}', {
          status: status.code,
        })) as unknown as typeof fetch,
    });
    const unauthorized = await m.testCustomModel({
      provider: 'private',
      baseUrl: BASE.baseUrl,
      apiKey: SECRET,
    });
    expect(unauthorized.message).toContain('拒绝了这把密钥');
    // 上游的响应体**不回显**：它可能带诊断信息与账号细节
    expect(unauthorized.message).not.toContain('内部诊断信息');
    expect(unauthorized.models).toBeUndefined();

    status.code = 404;
    const missing = await m.testCustomModel({
      provider: 'private',
      baseUrl: BASE.baseUrl,
      apiKey: SECRET,
    });
    expect(missing.message).toContain('没有 /models 列表');
  });

  it('endpoint 不是合法 URL 时**不发请求**，直接把那句话给回去', async () => {
    let called = false;
    const m = access({
      fetchFn: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await m.testCustomModel({
      provider: 'private',
      baseUrl: 'not-a-url',
      apiKey: SECRET,
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('对不上 OpenAI `{ data: [{ id }] }` 形状时不猜，让用户手填', () => {
    expect(parseOpenAiModelsList({ models: ['x'] })).toBeUndefined();
    expect(parseOpenAiModelsList({ data: [{ id: 'a' }, { id: 'a' }, { name: 'skip' }] })).toEqual([
      'a',
    ]);
  });
});

describe('「检查」按钮：200 不等于通了', () => {
  /**
   * 网关把**模型层面的失败放在流里**（`response.failed`），HTTP 仍然是 200。
   * 只看状态码的话，密钥错、模型不存在、上游断了，全都会被回答成"通了" ——
   * 用户要到真实任务里才发现。这与 CLAUDE.md §7 里 `verify-provider.mjs`
   * 那句"只看状态码会判错"是同一条教训。
   */
  function sse(...frames: readonly string[]): Response {
    return new Response(frames.map((f) => `data: ${f}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('流里是 response.failed → 没通，而且用流里那句中文', async () => {
    const result = await probeModel({
      baseUrl: 'http://127.0.0.1:8787/v1',
      token: 'gw-token',
      modelId: 'evowork/x',
      fetchFn: (async () =>
        sse(
          JSON.stringify({ type: 'response.created', response: { id: 'r1' } }),
          JSON.stringify({
            type: 'response.failed',
            response: { id: 'r1', error: { code: 'invalid_prompt', message: '密钥无效（401）。' } },
          }),
        )) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('密钥无效');
  });

  it('模型真的开口了 → 通了', async () => {
    const result = await probeModel({
      baseUrl: 'http://127.0.0.1:8787/v1',
      token: 'gw-token',
      modelId: 'evowork/x',
      fetchFn: (async () =>
        sse(
          JSON.stringify({ type: 'response.created', response: { id: 'r1' } }),
          JSON.stringify({ type: 'response.output_text.delta', delta: '好' }),
        )) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
  });

  it('`created` 和心跳都不算结论 —— 失败流也是以 created 开头的', () => {
    expect(probeVerdictFromLine('data: {"type":"response.created"}')).toBeUndefined();
    expect(probeVerdictFromLine('data: {"type":"response.in_progress"}')).toBeUndefined();
    expect(probeVerdictFromLine('data: [DONE]')).toBeUndefined();
    // 坏帧不作结论：一帧读不懂就判"没通"会把偶发的上游脏数据变成误报
    expect(probeVerdictFromLine('data: {不是 JSON')).toBeUndefined();
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

  it('启动之后才写下的 requirements.toml，env() 再读一次就能看到', () => {
    const m = access();
    writeFileSync(join(dir, 'requirements.toml'), '[models]\nallow_custom = false\n');
    const policy = JSON.parse(m.env()[MODEL_POLICY_ENV] as string) as {
      allowCustomModels: boolean;
    };
    expect(policy.allowCustomModels).toBe(false);
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
    expect(view.catalogReason).toBe('unreachable');
  });
});
