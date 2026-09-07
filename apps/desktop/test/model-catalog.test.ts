/**
 * 模型目录的读取（`main/model-catalog.ts`）。
 *
 * 这组测试盯的是**读错了会让用户看不出问题在哪**的地方：
 * 网关地址取错一个 provider、连不上时下拉悄悄变空、没令牌时白等一次超时。
 * "能不能解析 JSON"不在这里 —— 那件事错了会立刻报错。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelCatalogEntry } from '@evowork/gateway';

import {
  DEFAULT_GATEWAY_BASE_URL,
  fetchModelCatalog,
  parseGatewayBaseUrl,
  readGatewayBaseUrl,
  toModelOption,
  waitUntilGatewayReady,
} from '../src/main/model-catalog.js';

const CONFIG = `
model = "evowork/deepseek-v4-flash"
model_provider = "evowork"

[model_providers.evowork]
name = "EvoWork Gateway"
# base_url = "http://注释里的地址:1/v1"
base_url = "http://127.0.0.1:8791/v1"
wire_api = "responses"

[model_providers.other]
base_url = "https://someone-elses-gateway.example/v1"
`;

describe('网关地址：真源是内核的 config.toml（防两处漂移）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evowork-gw-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * **必须按段落取**。直接搜 `base_url` 会在企业配了第二个 provider 时取到错的那一个，
   * 而两个值都是合法 URL —— 没有任何一层会报错，表现是"下拉里的模型发过去说不存在"。
   */
  it('只取 [model_providers.evowork] 段里的 base_url，不取别的 provider 的', () => {
    expect(parseGatewayBaseUrl(CONFIG)).toBe('http://127.0.0.1:8791/v1');
  });

  it('注释掉的 base_url 不算数', () => {
    expect(parseGatewayBaseUrl('[model_providers.evowork]\n# base_url = "http://x/v1"\n')).toBe(
      undefined,
    );
  });

  it('配置文件读不到时退到默认地址，而不是抛错让整个宿主起不来', () => {
    expect(readGatewayBaseUrl(join(dir, '不存在'), {})).toBe(DEFAULT_GATEWAY_BASE_URL);
  });

  it('环境变量优先（开发时临时指到别的端口）', () => {
    writeFileSync(join(dir, 'config.toml'), CONFIG);
    expect(readGatewayBaseUrl(dir, { EVOWORK_GATEWAY_URL: 'http://127.0.0.1:9999/v1' })).toBe(
      'http://127.0.0.1:9999/v1',
    );
    expect(readGatewayBaseUrl(dir, {})).toBe('http://127.0.0.1:8791/v1');
  });
});

function entry(over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: 'evowork/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    upstreamModel: 'deepseek-v4-flash',
    tier: 'standard',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: false,
      maxContextTokens: 128_000,
    },
    verified: true,
    verifiedAt: '2026-09-05',
    unverified: ['maxContextTokens'],
    notes: '',
    notices: ['这个模型不支持图片输入，可切换模型。'],
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('目录条目 → 下拉选项', () => {
  it('标签是 `provider/上游模型名` —— 用户要能一眼看出发给谁、发的哪个型号', () => {
    expect(toModelOption(entry()).label).toBe('deepseek/deepseek-v4-flash');
  });

  /**
   * D2「降级必须显式」：缺失的能力**留在列表里标 false**（灰色划除），不删掉。
   * 删掉的话，"这个模型不支持图片"会变成用户拖了图片才发现的事。
   */
  it('缺失能力保留并标 available:false，不从列表里删掉', () => {
    const caps = toModelOption(entry()).capabilities;
    expect(caps.map((c) => c.id)).toEqual(['reasoning', 'image-input', 'parallel-tools']);
    expect(caps.find((c) => c.id === 'image-input')?.available).toBe(false);
  });
});

describe('取目录：失败都是**正常状态**，必须说清后果', () => {
  it('没有令牌就不发请求 —— 必然 401，白等一次超时没有意义', async () => {
    const fetchFn = vi.fn();
    const result = await fetchModelCatalog({
      baseUrl: 'http://127.0.0.1:8787/v1',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.models).toEqual([]);
    // 提示里要有"怎么办"，不只是"不行"
    expect(result.unavailable).toContain('gateway-token');
  });

  it('拼出来的地址是 {base}/evowork/models，且不会拼出双斜杠', async () => {
    const seen: string[] = [];
    await fetchModelCatalog({
      baseUrl: 'http://127.0.0.1:8787/v1/',
      token: 't',
      fetchFn: (async (url: string) => {
        seen.push(url);
        return jsonResponse({ data: [entry()] });
      }) as unknown as typeof fetch,
    });
    expect(seen).toEqual(['http://127.0.0.1:8787/v1/evowork/models']);
  });

  it('401 与其他状态码给不同的话 —— 令牌不对和网关挂了是两件事', async () => {
    const unauthorized = await fetchModelCatalog({
      baseUrl: 'http://x/v1',
      token: 't',
      fetchFn: (async () => jsonResponse({}, 401)) as unknown as typeof fetch,
    });
    expect(unauthorized.unavailable).toContain('401');

    const broken = await fetchModelCatalog({
      baseUrl: 'http://x/v1',
      token: 't',
      fetchFn: (async () => jsonResponse({}, 503)) as unknown as typeof fetch,
    });
    expect(broken.unavailable).toContain('503');
  });

  it('连不上时给的是"发不出任务"，不是一个空下拉', async () => {
    const result = await fetchModelCatalog({
      baseUrl: 'http://127.0.0.1:1/v1',
      token: 't',
      fetchFn: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(result.models).toEqual([]);
    expect(result.unavailable).toBeTruthy();
    expect(result.reason).toBe('unreachable');
  });

  /**
   * 网关活着但一个模型都没有 = 它启动时一家厂商密钥都没配。
   * 这一条与"连不上"必须分开说：两者的下一步动作完全不同。
   */
  it('网关活着但目录是空的 → 说清是密钥没配，不是网关没起', async () => {
    const result = await fetchModelCatalog({
      baseUrl: 'http://x/v1',
      token: 't',
      fetchFn: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(result.unavailable).toContain('密钥');
  });

  it('正常返回时把三家都映射出来', async () => {
    const result = await fetchModelCatalog({
      baseUrl: 'http://x/v1',
      token: 't',
      fetchFn: (async () =>
        jsonResponse({
          data: [
            entry(),
            entry({ id: 'evowork/kimi-k3', provider: 'moonshot', upstreamModel: 'kimi-k3' }),
            entry({ id: 'evowork/glm-flash', provider: 'zhipu', upstreamModel: 'glm-5.3-flash' }),
          ],
        })) as unknown as typeof fetch,
    });
    expect(result.unavailable).toBeUndefined();
    expect(result.models.map((m) => m.label)).toEqual([
      'deepseek/deepseek-v4-flash',
      'moonshot/kimi-k3',
      'zhipu/glm-5.3-flash',
    ]);
  });
});

describe('等到网关开始听端口', () => {
  it('连不上就重试，一旦端口在听就停 —— 否则启动瞬间会误报「连不上」', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new Error('connect ECONNREFUSED');
      return jsonResponse({ data: [entry()] });
    });
    await expect(
      waitUntilGatewayReady({
        baseUrl: 'http://127.0.0.1:1/v1',
        token: 't',
        fetchFn: fetchFn as unknown as typeof fetch,
        intervalMs: 1,
        readyTimeoutMs: 1000,
      }),
    ).resolves.toBe(true);
    expect(n).toBe(3);
  });

  it('timeout 0 立即放弃 —— 测试里假 spawn 不会真的听端口', async () => {
    const fetchFn = vi.fn();
    await expect(
      waitUntilGatewayReady({
        baseUrl: 'http://127.0.0.1:1/v1',
        token: 't',
        fetchFn: fetchFn as unknown as typeof fetch,
        readyTimeoutMs: 0,
      }),
    ).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
