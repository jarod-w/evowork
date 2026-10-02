/**
 * 「套件」= 内核插件市场里的插件包（13 §9 / §9.1，HUB-Q8=B）。
 *
 * 这里只有判定：哪些市场能出现在产品里、一个插件包装进来以后能做什么、装之前要不要人看。
 * 读盘与调内核都在桌面宿主。
 *
 * **滤掉的是通道，不是内容**（13 §9 第 2 条）：内核每次启动自己同步进 `<kernelHome>/.tmp/`
 * 的市场（OpenAI curated，名字有好几个、以后还会变）一律不进产品 —— 按路径判，不按名字判。
 */
import { isAbsolute, relative, resolve } from 'node:path';

import { auditSkillFiles, type AuditFile } from './audit.js';
import type { AuditFinding, AuditResult, RiskLevel } from './types.js';

/** `plugin/list` 的 `source`（`app-server-protocol/src/protocol/v2/plugin.rs` 的 `PluginSource`）。 */
export type BundleSource =
  | { readonly kind: 'local'; readonly path: string }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly path?: string | undefined;
      readonly refName?: string | undefined;
      readonly sha?: string | undefined;
    }
  | {
      readonly kind: 'npm';
      readonly package: string;
      readonly version?: string | undefined;
      readonly registry?: string | undefined;
    }
  | { readonly kind: 'remote' }
  | { readonly kind: 'unknown' };

export function parseBundleSource(raw: unknown): BundleSource {
  if (raw === null || typeof raw !== 'object') return { kind: 'unknown' };
  const rec = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  switch (rec.type) {
    case 'local': {
      const path = str(rec.path);
      return path === undefined ? { kind: 'unknown' } : { kind: 'local', path };
    }
    case 'git': {
      const url = str(rec.url);
      if (url === undefined) return { kind: 'unknown' };
      const path = str(rec.path);
      const refName = str(rec.refName);
      const sha = str(rec.sha);
      return {
        kind: 'git',
        url,
        ...(path !== undefined ? { path } : {}),
        ...(refName !== undefined ? { refName } : {}),
        ...(sha !== undefined ? { sha } : {}),
      };
    }
    case 'npm': {
      const pkg = str(rec.package);
      if (pkg === undefined) return { kind: 'unknown' };
      const version = str(rec.version);
      const registry = str(rec.registry);
      return {
        kind: 'npm',
        package: pkg,
        ...(version !== undefined ? { version } : {}),
        ...(registry !== undefined ? { registry } : {}),
      };
    }
    case 'remote':
      return { kind: 'remote' };
    default:
      return { kind: 'unknown' };
  }
}

/**
 * `path` 是否落在内核自己同步的目录（`<kernelHome>/.tmp/`）里。
 *
 * 判的是**这一类**：今天是 `.tmp/plugins` 下的 curated 市场，明天内核再往 `.tmp/` 同步别的市场，
 * 同样进不来。路径归一化后再比，`..` 绕不过去。
 */
export function isKernelSyncedPath(path: string, kernelHome: string): boolean {
  if (path.trim() === '' || kernelHome.trim() === '') return false;
  const root = resolve(kernelHome, '.tmp');
  const rel = relative(root, resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/* ── 插件包里有什么 ─────────────────────────────────────────────────────── */

export interface BundleMcpServer {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse' | 'unknown';
  readonly command?: string | undefined;
  readonly url?: string | undefined;
}

export interface BundleContents {
  /** 找到了 `.codex-plugin/plugin.json`（或 `.claude-plugin/plugin.json`）。 */
  readonly manifestFound: boolean;
  /** 声明了应用连接器（`.app.json`，K7：本产品不支持）。 */
  readonly hasApps: boolean;
  readonly hasHooks: boolean;
  readonly mcpServers: readonly BundleMcpServer[];
  /** `skills/<name>/SKILL.md` 的相对目录。 */
  readonly skillDirs: readonly string[];
}

const MANIFEST_PATHS = ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json'];
/** 内核在 manifest 没写时的默认位置（`core-plugins/src/loader.rs` 的 `DEFAULT_*`）。 */
const DEFAULT_MCP = '.mcp.json';
const DEFAULT_APPS = '.app.json';
const DEFAULT_HOOKS = 'hooks/hooks.json';

export function inspectBundleFiles(files: readonly AuditFile[]): BundleContents {
  const byPath = new Map(files.map((f) => [normalizeRel(f.relativePath), f]));
  const manifestFile = MANIFEST_PATHS.map((p) => byPath.get(p)).find((f) => f !== undefined);
  const manifest = parseJsonObject(manifestFile?.text);

  const appsRef = typeof manifest?.apps === 'string' ? normalizeRel(manifest.apps) : DEFAULT_APPS;
  const appsFile = byPath.get(appsRef);
  const hasApps =
    manifest?.apps !== undefined && manifest.apps !== null
      ? true
      : appsFile !== undefined && appsDeclared(appsFile.text);

  let hasHooks = false;
  const hooksField = manifest?.hooks;
  if (hooksField !== undefined && hooksField !== null) hasHooks = true;
  if (byPath.has(DEFAULT_HOOKS) || byPath.has('hooks.json')) hasHooks = true;

  const mcpServers: BundleMcpServer[] = [];
  const mcpField = manifest?.mcpServers;
  if (mcpField !== null && typeof mcpField === 'object' && !Array.isArray(mcpField)) {
    mcpServers.push(...parseMcpServers(mcpField as Record<string, unknown>));
  } else {
    const ref = typeof mcpField === 'string' ? normalizeRel(mcpField) : DEFAULT_MCP;
    const parsed = parseJsonObject(byPath.get(ref)?.text);
    if (parsed !== undefined) mcpServers.push(...parseMcpServers(parsed));
    else if (typeof mcpField === 'string' && byPath.has(ref)) {
      // 声明了、却读不懂：按能力面未知处理
      mcpServers.push({ name: ref, transport: 'unknown' });
    }
  }

  const skillDirs = [
    ...new Set(
      [...byPath.keys()]
        .filter((p) => /(^|\/)SKILL\.md$/.test(p))
        .map((p) => p.replace(/\/?SKILL\.md$/, '')),
    ),
  ].sort();

  return {
    manifestFound: manifestFile !== undefined,
    hasApps,
    hasHooks,
    mcpServers,
    skillDirs,
  };
}

function appsDeclared(text: string | undefined): boolean {
  const parsed = parseJsonObject(text);
  if (parsed === undefined) return text !== undefined && text.trim() !== '';
  const apps = parsed.apps;
  if (apps !== null && typeof apps === 'object') return Object.keys(apps).length > 0;
  return Object.keys(parsed).length > 0;
}

function parseMcpServers(raw: Record<string, unknown>): BundleMcpServer[] {
  const table =
    raw.mcpServers !== null && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)
      ? (raw.mcpServers as Record<string, unknown>)
      : raw;
  const out: BundleMcpServer[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    const command = typeof rec.command === 'string' ? rec.command : undefined;
    const url = typeof rec.url === 'string' ? rec.url : undefined;
    const type = typeof rec.type === 'string' ? rec.type.toLowerCase() : undefined;
    const transport: BundleMcpServer['transport'] =
      command !== undefined || type === 'stdio'
        ? 'stdio'
        : type === 'sse'
          ? 'sse'
          : url !== undefined
            ? 'http'
            : 'unknown';
    out.push({
      name,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(url !== undefined ? { url } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ── 安装前审计（9.1 第 1、3、4、5 条）──────────────────────────────────── */

/** 9.1 第 3 条的原句。**不出现 ChatGPT 字样**（K5）。 */
export const BUNDLE_APPS_REFUSAL = '包含本产品不支持的应用连接器';

export const BUNDLE_STDIO_WORST_CASE =
  '它会以你的身份在这台电脑上运行程序，能读写你能读写的所有文件。';

export interface BundleAudit extends AuditResult {
  /** 有值 = 不可安装，值是要给用户看的原因。 */
  readonly blockedReason?: string | undefined;
  /** 9.1 第 4 条：确认卡要逐个列出这些 server。 */
  readonly mcpServers: readonly BundleMcpServer[];
}

/**
 * 插件包的静态审计。和技能审计**同一套规则**（`auditSkillFiles`），再叠加插件包特有的成分：
 *
 * - 应用连接器 → 不可安装（K7）
 * - MCP server：stdio 一律 P2（它不在任务沙箱里，以用户身份直接跑），远程 = 有限网络 P1
 * - hooks → P2（05 §3.3）
 *
 * manifest 与 `.mcp.json` / `.app.json` 由上面结构化地判，不再拿去跑文本规则 ——
 * 否则 manifest 里的官网 / 隐私政策链接会让每一个插件包都被判成「有限网络」。
 */
export function auditBundleFiles(files: readonly AuditFile[]): BundleAudit {
  const contents = inspectBundleFiles(files);
  const structural = new Set(
    [...MANIFEST_PATHS, DEFAULT_MCP, DEFAULT_APPS].map((p) => p.toLowerCase()),
  );
  const rest = files.filter((f) => !structural.has(normalizeRel(f.relativePath).toLowerCase()));
  const base = auditSkillFiles(rest.length > 0 ? rest : files);

  const findings: AuditFinding[] = [...base.findings];
  let level: RiskLevel = base.level;
  let worst = base.worstCase;
  const raise = (next: RiskLevel, finding: AuditFinding, worstCase?: string) => {
    findings.push(finding);
    if (rank(next) > rank(level)) {
      level = next;
      if (worstCase !== undefined) worst = worstCase;
    }
  };

  if (!contents.manifestFound) {
    raise(
      'p2',
      { code: 'no-manifest', detail: '没有找到插件清单（plugin.json），能力面未知。' },
      '无法判断它会带进哪些技能、连接器或钩子。',
    );
  }
  for (const server of contents.mcpServers) {
    if (server.transport === 'stdio' || server.transport === 'unknown') {
      raise(
        'p2',
        {
          code: 'mcp-stdio',
          detail: `连接器「${server.name}」会在本机运行程序${server.command !== undefined ? `（${server.command}）` : ''}。`,
        },
        BUNDLE_STDIO_WORST_CASE,
      );
    } else {
      raise('p1', {
        code: 'mcp-remote',
        detail: `连接器「${server.name}」会访问 ${hostOf(server.url) ?? '远程服务'}。`,
      });
    }
  }
  if (contents.hasHooks && !findings.some((f) => f.code === 'hooks')) {
    raise(
      'p2',
      { code: 'hooks', detail: '插件声明了 hooks，可拦截所有工具调用。' },
      '它可以在每一次工具调用前后插入自己的逻辑，包括改参数和静默放行。',
    );
  }

  return {
    level,
    findings,
    ...(worst !== undefined ? { worstCase: worst } : {}),
    ...(contents.hasApps ? { blockedReason: BUNDLE_APPS_REFUSAL } : {}),
    mcpServers: contents.mcpServers,
  };
}

/* ── 列表：哪些市场能进产品 ─────────────────────────────────────────────── */

/** `plugin/list` 响应里我们读的那一部分（结构化子集，避免本包依赖协议包）。 */
export interface PluginListLike {
  readonly marketplaces: readonly {
    readonly name: string;
    readonly path?: string | null;
    readonly interface?: { readonly displayName?: string | null } | null;
    readonly plugins: readonly {
      readonly id: string;
      readonly name: string;
      readonly source: unknown;
      readonly installed: boolean;
      readonly enabled: boolean;
      readonly version?: string | null;
      readonly localVersion?: string | null;
      readonly installPolicy?: string;
      readonly availability?: string;
      readonly disabledReason?: string | null;
      readonly interface?: {
        readonly displayName?: string | null;
        readonly shortDescription?: string | null;
        readonly longDescription?: string | null;
        readonly category?: string | null;
      } | null;
    }[];
  }[];
  readonly marketplaceLoadErrors: readonly {
    readonly marketplacePath: string;
    readonly message: string;
  }[];
}

export interface BundleRecord {
  readonly id: string;
  readonly name: string;
  readonly pluginName: string;
  readonly description: string;
  readonly category: string;
  readonly marketplaceName: string;
  /** 市场的原始 `name`：内核把装好的插件放在 `plugins/cache/<它>/<插件名>/<版本>`。 */
  readonly marketplaceId: string;
  readonly marketplacePath: string;
  readonly source: BundleSource;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly version?: string | undefined;
  /** 内核自己说不可用（`installPolicy` / `availability`）。 */
  readonly kernelUnavailableReason?: string | undefined;
}

export interface BundleList {
  readonly bundles: readonly BundleRecord[];
  readonly errors: readonly { readonly path: string; readonly message: string }[];
}

/**
 * 把 `plugin/list` 收成产品里能出现的套件。
 *
 * 内核自己同步的市场整个滤掉；没有本机路径的市场也不列（说不清它从哪来，就没法先审后装），
 * 但**写进 errors**，不静默丢。
 */
export function listBundles(response: PluginListLike, kernelHome: string): BundleList {
  const bundles: BundleRecord[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const error of response.marketplaceLoadErrors) {
    if (isKernelSyncedPath(error.marketplacePath, kernelHome)) continue;
    errors.push({ path: error.marketplacePath, message: error.message });
  }
  for (const market of response.marketplaces) {
    const path = market.path ?? '';
    if (path === '') {
      errors.push({ path: market.name, message: '这个市场没有本机路径，没有列出。' });
      continue;
    }
    if (isKernelSyncedPath(path, kernelHome)) continue;
    const marketplaceName = market.interface?.displayName ?? market.name;
    for (const plugin of market.plugins) {
      const source = parseBundleSource(plugin.source);
      if (source.kind === 'local' && isKernelSyncedPath(source.path, kernelHome)) continue;
      const version = plugin.localVersion ?? plugin.version ?? undefined;
      const kernelUnavailable =
        plugin.installPolicy === 'NOT_AVAILABLE' || plugin.availability === 'DISABLED_BY_ADMIN';
      bundles.push({
        id: plugin.id,
        name: plugin.interface?.displayName ?? plugin.name,
        pluginName: plugin.name,
        description:
          plugin.interface?.shortDescription ?? plugin.interface?.longDescription ?? plugin.name,
        category: plugin.interface?.category ?? '套件',
        marketplaceName,
        marketplaceId: market.name,
        marketplacePath: path,
        source,
        installed: plugin.installed,
        enabled: plugin.enabled,
        ...(version !== undefined && version !== null ? { version } : {}),
        ...(kernelUnavailable
          ? { kernelUnavailableReason: plugin.disabledReason ?? '这个套件当前不可安装' }
          : {}),
      });
    }
  }
  return { bundles, errors };
}

/** 套件卡片上的来源标签。本机 / 工作区市场 = 用户自己放的，与「从本地目录安装」同一信任级别。 */
export function bundleSourceLabel(source: BundleSource): string {
  if (source.kind === 'git') return 'Git';
  if (source.kind === 'npm') return 'npm';
  return '本地目录';
}

/** 9.1 第 2 条：内容要等内核装的时候才去取，取不到时如实说要能访问哪台主机。 */
export function bundleSourceHost(source: BundleSource): string | undefined {
  if (source.kind === 'git') return hostOf(source.url) ?? source.url;
  if (source.kind === 'npm') return hostOf(source.registry) ?? 'registry.npmjs.org';
  return undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    const scp = /^[^@\s]+@([^:\s]+):/.exec(url);
    return scp?.[1];
  }
}

function normalizeRel(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  try {
    const raw = JSON.parse(text) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function rank(level: RiskLevel): number {
  if (level === 'p0') return 0;
  if (level === 'p1') return 1;
  return 2;
}
