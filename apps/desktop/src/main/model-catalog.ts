/**
 * 模型下拉的数据源：**读网关的能力端点**，不是内核的 `model/list`（F24）。
 *
 * 三个理由写在 `services/gateway/src/catalog.ts` 的头注释里，第一个是决定性的：
 * **只有网关知道哪家厂商的密钥真的配好了**。内核会把连不上的模型也列出来，
 * 而用户要等到发出一句话、任务失败才知道 —— 03 §8 要求的恰恰相反。
 *
 * ## 这是一条出网路径（K6）
 *
 * 本机部署时它打的是 `127.0.0.1`；云端托管时它真的出网（到我们自己的网关）。
 * 按 K6 的要求登记在总纲 §9 的出网清单里。**它只发一个 GET，不带任何用户内容** ——
 * 没有 prompt、没有文件名、没有任务 id，只有一个 Bearer 令牌。
 *
 * ## 为什么不并进 `getStartup()`
 *
 * `shared/ipc.ts` 论证过"首页数据一次给全"，但那条的前提是**数据同源**：场景、权限、
 * 案例都来自同一次内核握手，拆开只会制造"场景到了、权限还没到"的中间态。
 * 模型列表不同源 —— 它是一次**网络调用**，失败方式也不同：
 *
 *   · 本机服务起不来 → 整个界面没有意义，首页显示"没有连上本机服务"；
 *   · 网关连不上     → 界面完全可用（能翻历史任务、看产物），只是**不能发新消息**。
 *
 * 把后者并进前者，等于让网关的一次超时把整个首页拖成白屏。所以它是单独一个动作，
 * 并且**允许失败**：失败时下拉为空 + Composer 上一条 danger 提示（03 §8）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ModelCatalogEntry, ModelCatalogResponse } from '@evowork/gateway';

import type { ModelCatalogResult, ModelOptionView } from '../shared/ipc.js';

/** 网关地址的兜底值。与 `config/config.toml.template` 里的 `base_url` 一致。 */
export const DEFAULT_GATEWAY_BASE_URL = 'http://127.0.0.1:8787/v1';

/** 网关不通时给用户看的话。**不猜原因**，只说清后果与下一步。 */
export const GATEWAY_UNREACHABLE =
  '连不上模型网关，现在发不出任务。确认网关已启动、地址与令牌正确后重试。';

/**
 * 网关地址的真源是**内核的 `config.toml`**，不是另起一个 EvoWork 侧的配置项。
 *
 * 理由是防止两处漂移：企业把网关换成私有部署时改的是 `config.toml`（内核靠它发请求）。
 * 若模型列表读另一个配置，改完之后**内核打私有网关、下拉打默认网关** ——
 * 表现是"下拉里的模型发过去说不存在"，而两处配置各自都是对的。
 *
 * 这个文件已经是 `config.toml` 的写入方（`ensureKernelConfig`），读回同一个键不新增边界。
 * 环境变量 `EVOWORK_GATEWAY_URL` 优先，用于开发时临时指到别的端口。
 *
 * **只认一个键**，所以用正则而不是引入 TOML 解析器：需要的是
 * `[model_providers.evowork]` 段里的 `base_url`，而不是整棵配置树。
 */
export function readGatewayBaseUrl(
  kernelHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.EVOWORK_GATEWAY_URL?.trim();
  if (fromEnv) return fromEnv;

  let text: string;
  try {
    text = readFileSync(join(kernelHome, 'config.toml'), 'utf8');
  } catch {
    return DEFAULT_GATEWAY_BASE_URL;
  }
  return parseGatewayBaseUrl(text) ?? DEFAULT_GATEWAY_BASE_URL;
}

/**
 * 从 `config.toml` 文本里取 `[model_providers.evowork]` 段的 `base_url`。
 *
 * 导出是为了单独测。**段落判定不能省** —— 直接搜 `base_url` 会在企业配了第二个
 * provider（比如一个私有 endpoint）时取到错的那一个，而两个值都是合法的 URL，
 * 不会有任何一层报错。
 */
export function parseGatewayBaseUrl(configToml: string): string | undefined {
  let inSection = false;
  for (const rawLine of configToml.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inSection = line === '[model_providers.evowork]';
      continue;
    }
    if (!inSection) continue;
    const match = /^base_url\s*=\s*["']([^"']+)["']/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export interface FetchCatalogOptions {
  readonly baseUrl: string;
  /** 网关访问令牌。没有令牌时**不发请求** —— 必然 401，多一次超时没有意义 */
  readonly token?: string | undefined;
  /** 注入以便测试 */
  readonly fetchFn?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/** 端点路径。与网关的 `MODELS_ENDPOINT_PATH` 对应，但那是绝对路径、这里拼在 base 之后。 */
const MODELS_PATH = '/evowork/models';

/**
 * 取一次模型目录。
 *
 * **不抛异常**：调用方是一个 IPC 动作，而"网关连不上"是一个正常的运行状态，
 * 不是程序错误。它作为 `unavailable` 返回，渲染层据此渲染 03 §8 的 danger 条。
 */
export async function fetchModelCatalog(options: FetchCatalogOptions): Promise<ModelCatalogResult> {
  if (!options.token) {
    return {
      models: [],
      reason: 'no-token',
      unavailable:
        '还没有配置模型网关的访问令牌，任务发出去会失败。' +
        '把令牌写进 ~/.evowork/gateway-token（一行），或用 EVOWORK_GATEWAY_TOKEN 启动。',
    };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, '')}${MODELS_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await fetchFn(url, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      // 401 与 503 对用户是两件事，但都不该显示原始响应体（可能带上游的诊断信息）
      return {
        models: [],
        reason: response.status === 401 ? 'unauthorized' : 'http',
        unavailable:
          response.status === 401
            ? '模型网关拒绝了这个令牌（401）。确认 ~/.evowork/gateway-token 与网关的 EVOWORK_GATEWAY_TOKENS 一致。'
            : `模型网关返回了 ${response.status}，现在发不出任务。`,
      };
    }
    const body = (await response.json()) as ModelCatalogResponse;
    const models = (body.data ?? []).map(toModelOption);
    if (models.length === 0) {
      // 网关活着但一个模型都没有 = 一家厂商的密钥都没配。**说清楚是哪一侧的问题**
      return {
        models: [],
        reason: 'empty',
        unavailable: '模型网关没有可用的模型：它启动时没有配置任何厂商密钥。',
      };
    }
    return { models };
  } catch {
    return { models: [], reason: 'unreachable', unavailable: GATEWAY_UNREACHABLE };
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 等到本机网关开始听端口。
 *
 * `spawn` 返回只说明进程在，不说明 `listen` 已经完成。网关冷启动要几百毫秒；
 * 这段窗口里去 fetch，得到的就是 ECONNREFUSED，界面上写成「连不上模型网关」。
 * 启动后立刻点「检查模型接入」又好了 —— 最像配置问题、其实是时序问题。
 *
 * **`reason !== 'unreachable'` 就算就绪**：401 / 空目录 / 成功都证明端口在听。
 */
export async function waitUntilGatewayReady(
  options: FetchCatalogOptions & {
    readonly readyTimeoutMs?: number | undefined;
    readonly intervalMs?: number | undefined;
  },
): Promise<boolean> {
  const budget = options.readyTimeoutMs ?? 8_000;
  if (budget <= 0) return false;
  const deadline = Date.now() + budget;
  const interval = options.intervalMs ?? 200;
  while (Date.now() < deadline) {
    const result = await fetchModelCatalog({ ...options, timeoutMs: options.timeoutMs ?? 400 });
    if (result.reason !== 'unreachable') return true;
    await delay(interval);
  }
  return false;
}

/**
 * 目录条目 → 下拉选项。
 *
 * **缺失能力保留在列表里并标 `available:false`**，由 `ModelSelect` 渲染成灰色划除 ——
 * 隐藏会让"这个模型不支持图片"变成用户拖了图片才发现的事（D2「降级必须显式」）。
 */
export function toModelOption(entry: ModelCatalogEntry): ModelOptionView {
  return {
    id: entry.id,
    // 01 §5.15：等宽的 `provider/model`。用上游真实模型名而不是 displayName ——
    // 用户要能一眼看出发给谁、发的是哪个型号
    label: `${entry.provider}/${entry.upstreamModel}`,
    provider: entry.provider,
    capabilities: [
      { id: 'reasoning', label: '推理', available: entry.capabilities.reasoning },
      { id: 'image-input', label: '读图', available: entry.capabilities.imageInput },
      { id: 'parallel-tools', label: '并行工具', available: entry.capabilities.parallelToolCalls },
    ],
    notices: entry.notices,
  };
}
