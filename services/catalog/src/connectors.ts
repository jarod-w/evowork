import type { ConnectorRecord, ConnectorTransport, ToolPolicy } from './types.js';

export const BROWSER_CONNECTOR_ID = 'browser';

export interface ConnectorStore {
  readonly connectors: readonly StoredConnector[];
}

export interface StoredConnector {
  readonly id: string;
  readonly name: string;
  readonly kind: 'official' | 'hub' | 'custom';
  readonly transport: ConnectorTransport;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly url?: string | undefined;
  readonly envKeys?: readonly string[] | undefined;
  /**
   * 写死的、**不是密钥**的环境变量（如 `ELECTRON_RUN_AS_NODE=1`：用户机器上没有 node，
   * Hub 的 stdio 连接器用 Electron 自己充当 node）。密钥只走 `envKeys`（只有名）。
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly trusted: boolean;
  readonly toolPolicy: Readonly<Record<string, ToolPolicy>>;
  readonly disabledReason?: string | undefined;
}

export function emptyStore(): ConnectorStore {
  return { connectors: [] };
}

export function parseConnectorStore(text: string | undefined): ConnectorStore {
  if (text === undefined || text.trim() === '') return emptyStore();
  try {
    const raw = JSON.parse(text) as { connectors?: unknown };
    if (!Array.isArray(raw.connectors)) return emptyStore();
    const connectors: StoredConnector[] = [];
    for (const item of raw.connectors) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.id !== 'string' || typeof rec.name !== 'string') continue;
      const transport = rec.transport;
      if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') continue;
      const kind = rec.kind === 'official' ? 'official' : rec.kind === 'hub' ? 'hub' : 'custom';
      connectors.push({
        id: rec.id,
        name: rec.name,
        kind,
        transport,
        ...(typeof rec.command === 'string' ? { command: rec.command } : {}),
        ...(Array.isArray(rec.args) ? { args: rec.args.filter((a) => typeof a === 'string') } : {}),
        ...(typeof rec.url === 'string' ? { url: rec.url } : {}),
        ...(Array.isArray(rec.envKeys)
          ? { envKeys: rec.envKeys.filter((a) => typeof a === 'string') }
          : {}),
        ...(parseEnv(rec.env) !== undefined ? { env: parseEnv(rec.env) } : {}),
        trusted: rec.trusted === true,
        toolPolicy: parseToolPolicy(rec.toolPolicy),
        ...(typeof rec.disabledReason === 'string' ? { disabledReason: rec.disabledReason } : {}),
      });
    }
    return { connectors };
  } catch {
    return emptyStore();
  }
}

function parseEnv(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseToolPolicy(raw: unknown): Readonly<Record<string, ToolPolicy>> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, ToolPolicy> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === 'approve' || value === 'allow') out[key] = value;
  }
  return out;
}

export function serializeConnectorStore(store: ConnectorStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

export interface OfficialLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/**
 * 官方 `browser` 的启动方式**永远取当前这次安装的**，不信 `connectors.json` 里存的那份：
 * 应用升级后随包路径会变；而 2026-10-02 之前存进去的是 `command = "node"` ——
 * 用户机器上没有 node，那条连接器信任之后也起不来。用户能改的只有信任与工具权限。
 */
export function withOfficialLaunch(
  store: ConnectorStore,
  official: OfficialLaunch,
): ConnectorStore {
  return {
    connectors: store.connectors.map((c) =>
      c.id === BROWSER_CONNECTOR_ID && c.kind === 'official'
        ? {
            ...c,
            command: official.command,
            args: official.args,
            ...(official.env !== undefined ? { env: official.env } : { env: undefined }),
          }
        : c,
    ),
  };
}

/**
 * 官方 `browser` 永远在列表里（Q9：本期唯一官方连接器）。
 * 用户条目覆盖同 id；没有用户条目时用随包路径补一条未信任的。
 */
export function mergeConnectors(
  rawStore: ConnectorStore,
  officialBrowser: OfficialLaunch,
): readonly ConnectorRecord[] {
  const store = withOfficialLaunch(rawStore, officialBrowser);
  const fromStore = store.connectors.map((c) => toRecord(c));
  if (fromStore.some((c) => c.id === BROWSER_CONNECTOR_ID)) return fromStore;
  return [
    toRecord({
      id: BROWSER_CONNECTOR_ID,
      name: '浏览器',
      kind: 'official',
      transport: 'stdio',
      command: officialBrowser.command,
      args: officialBrowser.args,
      ...(officialBrowser.env !== undefined ? { env: officialBrowser.env } : {}),
      trusted: false,
      toolPolicy: {},
    }),
    ...fromStore,
  ];
}

function toRecord(c: StoredConnector): ConnectorRecord {
  const status = connectorStatus(c);
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    transport: c.transport,
    ...(c.command !== undefined ? { command: c.command } : {}),
    ...(c.args !== undefined ? { args: c.args } : {}),
    ...(c.url !== undefined ? { url: c.url } : {}),
    ...(c.envKeys !== undefined ? { envKeys: c.envKeys } : {}),
    trusted: c.trusted,
    status,
    category: c.id === BROWSER_CONNECTOR_ID ? 'browser' : 'custom',
    toolPolicy: c.toolPolicy,
    ...(c.disabledReason !== undefined ? { disabledReason: c.disabledReason } : {}),
  };
}

export function connectorStatus(c: StoredConnector): ConnectorRecord['status'] {
  if (c.disabledReason !== undefined) return 'disabled';
  if (!c.trusted) return 'untrusted';
  return 'disconnected';
}

/** 信任官方 browser 之前要先有一条可写的记录；getCatalog 合并不会落盘。 */
export function ensureOfficialBrowser(
  rawStore: ConnectorStore,
  official: OfficialLaunch,
): ConnectorStore {
  const store = withOfficialLaunch(rawStore, official);
  if (store.connectors.some((c) => c.id === BROWSER_CONNECTOR_ID)) return store;
  return upsertConnector(store, {
    id: BROWSER_CONNECTOR_ID,
    name: '浏览器',
    kind: 'official',
    transport: 'stdio',
    command: official.command,
    args: official.args,
    ...(official.env !== undefined ? { env: official.env } : {}),
    trusted: false,
    toolPolicy: {},
  });
}

export function upsertConnector(store: ConnectorStore, next: StoredConnector): ConnectorStore {
  const rest = store.connectors.filter((c) => c.id !== next.id);
  return { connectors: [...rest, next] };
}

export function removeConnector(store: ConnectorStore, id: string): ConnectorStore {
  if (id === BROWSER_CONNECTOR_ID) {
    const existing = store.connectors.find((c) => c.id === id);
    if (existing === undefined) return store;
    return upsertConnector(store, { ...existing, trusted: false, disabledReason: undefined });
  }
  return { connectors: store.connectors.filter((c) => c.id !== id) };
}

export function trustConnector(store: ConnectorStore, id: string): ConnectorStore {
  const existing = store.connectors.find((c) => c.id === id);
  if (existing === undefined) return store;
  return upsertConnector(store, { ...existing, trusted: true });
}

export function setConnectorToolPolicy(
  store: ConnectorStore,
  id: string,
  tool: string,
  policy: ToolPolicy | undefined,
): ConnectorStore {
  const existing = store.connectors.find((c) => c.id === id);
  if (existing === undefined) return store;
  const toolPolicy = { ...existing.toolPolicy };
  if (policy === undefined) delete toolPolicy[tool];
  else toolPolicy[tool] = policy;
  return upsertConnector(store, { ...existing, toolPolicy });
}

export function slugConnectorName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'connector' : slug;
}

/** 信任后写入内核 config.toml 的 mcp_servers 段。已有同名段则替换。 */
export function patchMcpServersToml(
  toml: string,
  servers: readonly {
    readonly id: string;
    readonly command?: string | undefined;
    readonly args?: readonly string[] | undefined;
    readonly url?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly transport: ConnectorTransport;
  }[],
): string {
  const body = stripMcpServerSections(toml).trimEnd();
  const trusted = servers.filter((s) => s.command !== undefined || s.url !== undefined);
  if (trusted.length === 0) return body === '' ? '' : `${body}\n`;
  const blocks = trusted.map((s) => renderMcpBlock(s));
  return `${body}\n\n# evowork-mcp-begin\n${blocks.join('\n\n')}\n# evowork-mcp-end\n`;
}

function stripMcpServerSections(toml: string): string {
  const marked = toml.replace(/\n?# evowork-mcp-begin[\s\S]*?# evowork-mcp-end\n?/g, '\n');
  return marked.replace(/\n\[mcp_servers\.[^\]]+\][\s\S]*?(?=\n\[|\n*$)/g, '\n');
}

function renderMcpBlock(s: {
  readonly id: string;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly url?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly transport: ConnectorTransport;
  readonly toolPolicy?: Readonly<Record<string, ToolPolicy>>;
}): string {
  const lines = [`[mcp_servers.${escapeTomlKey(s.id)}]`];
  if (s.transport === 'stdio' && s.command !== undefined) {
    lines.push(`command = ${tomlString(s.command)}`);
    if (s.args !== undefined && s.args.length > 0) {
      lines.push(`args = [${s.args.map(tomlString).join(', ')}]`);
    }
    const env = Object.entries(s.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (env.length > 0) {
      lines.push(`env = { ${env.map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`);
    }
  } else if (s.url !== undefined) {
    lines.push(`url = ${tomlString(s.url)}`);
  }
  for (const [tool, policy] of Object.entries(s.toolPolicy ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(
      '',
      `[mcp_servers.${escapeTomlKey(s.id)}.tools.${escapeTomlKey(tool)}]`,
      `approval_mode = ${tomlString(policy === 'approve' ? 'prompt' : 'approve')}`,
    );
  }
  return lines.join('\n');
}

function escapeTomlKey(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : `"${id.replace(/"/g, '\\"')}"`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const CONNECTOR_CAPTION =
  '本版支持通过 MCP 协议接入任意第三方服务。官方连接器目录将在后续版本提供。';
