/** 官方 browser MCP 的来源契约；实时与历史都读同一条内核 item，不另建持久化副本。 */
export interface WebSource {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly kind: 'search' | 'page';
  readonly retrievedAt: string;
  readonly excerpt: string;
  readonly truncated: boolean;
}

export interface WebResearchResult {
  readonly kind: 'search' | 'page';
  readonly query: string;
  readonly sources: readonly WebSource[];
}

export function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function webResearchResult(item: {
  readonly type: string;
  readonly [key: string]: unknown;
}): WebResearchResult | undefined {
  if (
    item.type !== 'mcpToolCall' ||
    item.server !== 'browser' ||
    !['browser_search', 'browser_read_page'].includes(String(item.tool)) ||
    item.status !== 'completed'
  )
    return undefined;
  const result = record(item.result);
  if (!result || result.isError === true || item.error || !Array.isArray(result.content))
    return undefined;
  for (const block of result.content) {
    const content = record(block);
    if (
      content?.type !== 'text' ||
      typeof content.text !== 'string' ||
      content.text.length > 150000
    )
      continue;
    let parsed;
    try {
      parsed = record(JSON.parse(content.text));
    } catch {
      continue;
    }
    const kind = item.tool === 'browser_search' ? 'search' : 'page';
    if (
      parsed?.evoworkWeb !== 1 ||
      parsed.ok !== true ||
      parsed.kind !== kind ||
      !Array.isArray(parsed.sources) ||
      parsed.sources.length > 10
    )
      continue;
    const sources: WebSource[] = [];
    for (const raw of parsed.sources) {
      const source = record(raw);
      if (!source) continue;
      const url = webUrl(source.url);
      if (
        !url ||
        typeof source.id !== 'string' ||
        !/^web_[a-f0-9]{16}$/.test(source.id) ||
        source.kind !== kind ||
        typeof source.title !== 'string' ||
        source.title.length > 300 ||
        typeof source.retrievedAt !== 'string' ||
        !Number.isFinite(Date.parse(source.retrievedAt)) ||
        typeof source.excerpt !== 'string' ||
        source.excerpt.length > 12000 ||
        typeof source.truncated !== 'boolean'
      )
        continue;
      sources.push({
        id: source.id,
        url,
        title: source.title,
        kind,
        retrievedAt: source.retrievedAt,
        excerpt: source.excerpt,
        truncated: source.truncated,
      });
    }
    if (sources.length)
      return {
        kind,
        query: typeof parsed.query === 'string' ? parsed.query.slice(0, 500) : '',
        sources,
      };
  }
  return undefined;
}

export function mergeWebSources(
  previous: readonly WebSource[],
  incoming: readonly WebSource[],
): readonly WebSource[] {
  if (!incoming.length) return previous;
  const sources = new Map(previous.map((source) => [source.id, source]));
  for (const source of incoming) {
    if (source.kind === 'search' && sources.get(source.id)?.kind === 'page') continue;
    sources.set(source.id, source);
  }
  return [...sources.values()];
}

/** 每条助手消息只关联在它之前出现的来源；分组/分页不改变来源时序。 */
export function webSourcesByItem(
  items: readonly { readonly id: string; readonly type: string; readonly [key: string]: unknown }[],
): ReadonlyMap<string, readonly WebSource[]> {
  let sources: readonly WebSource[] = [];
  const byItem = new Map<string, readonly WebSource[]>();
  for (const item of items) {
    sources = mergeWebSources(sources, webResearchResult(item)?.sources ?? []);
    byItem.set(item.id, sources);
  }
  return byItem;
}
