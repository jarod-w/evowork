/**
 * 「套件」= 内核插件包的安装与卸载（13 §9.1，HUB-Q8=B / HUB-Q8a=B）。
 *
 * 内核的 `plugin/install` **不验签名、不经过我们的 P0/P1/P2 审计**（F37 / HF2），
 * 所以每一次安装都在这里先过审计：
 *
 * - **本机来源**：内容在安装前就在磁盘上 → 先审后装。
 * - **git / npm 来源**：内容要等内核装的时候才去取 → **先装后审**：装完立刻写停用
 *   （内核安装会无条件把它写成启用，预写停用没用 —— 13 §12 V6；中间那段空窗如实登记在 13 §14）、
 *   审计落盘目录，通过并经用户确认后才启用；带应用连接器的立刻卸载。
 *
 * 判定都在 `@evowork/catalog`；这里只接线。**渲染层传来的 marketplacePath 不可信**：
 * 安装前一律重新列一遍，只认 `listBundles` 放行的条目 —— 否则渲染层直接传
 * `<kernelHome>/.tmp/...` 就绕过了 13 §9 的过滤。
 */
import { join } from 'node:path';

import {
  auditBundleFiles,
  bundleSourceHost,
  bundleSourceLabel,
  listBundles,
  riskLabel,
  type BundleAudit,
  type BundleRecord,
  type CatalogIo,
  type PluginListLike,
} from '@evowork/catalog';

import type { CatalogBundleView, CatalogMutationResult } from '../shared/ipc.js';

export interface BundlePorts {
  readonly kernelHome: string;
  readonly io: CatalogIo;
  readonly listPlugins: (cwds: readonly string[]) => Promise<PluginListLike>;
  readonly install: (input: {
    readonly marketplacePath: string;
    readonly pluginName: string;
  }) => Promise<void>;
  readonly uninstall: (pluginId: string) => Promise<void>;
  readonly setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  /** 工作区市场：项目根目录（9.1 第 6 条）。 */
  readonly workspaceRoots: () => readonly string[];
}

export interface InstallBundleInput {
  readonly marketplacePath: string;
  readonly pluginName: string;
  readonly acknowledge?: boolean | undefined;
  readonly confirmName?: string | undefined;
}

/** 插件包可能比技能深（`skills/<x>/scripts/...`）。 */
const BUNDLE_SCAN_DEPTH = 6;

export interface BundleCatalog {
  readonly bundles: readonly CatalogBundleView[];
  readonly bundleErrors: readonly { readonly path: string; readonly message: string }[];
}

/**
 * 列出产品里能出现的套件，并给每一条附上它的审计结论。
 *
 * 列表读失败**写进 bundleErrors**，不吞成空列表（13 §9 第 3 条）—— 修复之前「套件」Tab
 * 是空的，正是因为请求失败、错误被吞掉了（F39）。
 */
export async function readBundles(ports: BundlePorts): Promise<BundleCatalog> {
  let response: PluginListLike;
  try {
    response = await ports.listPlugins(ports.workspaceRoots());
  } catch (error: unknown) {
    return {
      bundles: [],
      bundleErrors: [
        {
          path: '套件',
          message: `没能读取本机市场：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  const { bundles, errors } = listBundles(response, ports.kernelHome);
  return {
    bundles: bundles.map((bundle) => toView(bundle, auditOf(ports, bundle))),
    bundleErrors: errors,
  };
}

export async function installBundle(
  ports: BundlePorts,
  input: InstallBundleInput,
): Promise<Omit<CatalogMutationResult, 'catalog'>> {
  const found = await findBundle(ports, input.marketplacePath, input.pluginName);
  if (!found.ok) return { ok: false, refused: found.refused };
  const bundle = found.bundle;
  if (bundle.kernelUnavailableReason !== undefined) {
    return { ok: false, refused: bundle.kernelUnavailableReason };
  }

  if (bundle.source.kind === 'local') {
    if (bundle.installed) return { ok: false, refused: '这个套件已经装上了。' };
    const audit = auditBundleFiles(ports.io.listFiles(bundle.source.path, BUNDLE_SCAN_DEPTH));
    const gate = confirmGate(bundle, audit, input);
    if (gate !== undefined) return gate;
    try {
      await ports.install({
        marketplacePath: bundle.marketplacePath,
        pluginName: bundle.pluginName,
      });
    } catch (error: unknown) {
      return { ok: false, refused: errorText(error, '套件没有安装。') };
    }
    return { ok: true };
  }

  if (bundle.source.kind === 'git' || bundle.source.kind === 'npm') {
    return installRemoteSourced(ports, bundle, input);
  }

  return { ok: false, refused: '认不出这个套件的来源，EvoWork 无法在安装前检查它。' };
}

/**
 * git / npm：先装后审（HUB-Q8a=B）。
 *
 * 第一次点「安装」：内核安装 → 立刻写停用 → 审计落盘目录。
 * P0 直接启用；P1 / P2 停在「待确认」（已装、停用），由用户再点一次确认才启用。
 */
async function installRemoteSourced(
  ports: BundlePorts,
  bundle: BundleRecord,
  input: InstallBundleInput,
): Promise<Omit<CatalogMutationResult, 'catalog'>> {
  if (bundle.installed && bundle.enabled) return { ok: false, refused: '这个套件已经装上了。' };

  if (!bundle.installed) {
    // 不预写停用：内核装完会无条件写 `enabled = true`（`core-plugins/src/manager.rs:2256`
    // 的 `set_user_plugin_enabled(.., true)`，13 §12 V6 实测），预写没有用。
    try {
      await ports.install({
        marketplacePath: bundle.marketplacePath,
        pluginName: bundle.pluginName,
      });
    } catch (error: unknown) {
      const host = bundleSourceHost(bundle.source);
      const reason = errorText(error, '套件没有安装。');
      return {
        ok: false,
        refused: host !== undefined ? `${reason}（需要能访问 ${host}）` : reason,
      };
    }
    // 装完立刻压回停用。从 install 返回到这一步之间有一段空窗：恰好在这时开始的任务
    // 可能加载到它（13 §14 登记）。
    try {
      await ports.setEnabled(bundle.id, false);
    } catch (error: unknown) {
      await ports.uninstall(bundle.id).catch(() => undefined);
      return { ok: false, refused: `没能把套件保持在停用状态，已卸载：${errorText(error, '')}` };
    }
  }

  const dir = installedDir(ports, bundle);
  if (dir === undefined) {
    await ports.uninstall(bundle.id).catch(() => undefined);
    return { ok: false, refused: '找不到内核装好的套件目录，无法检查，已卸载。' };
  }
  const audit = auditBundleFiles(ports.io.listFiles(dir, BUNDLE_SCAN_DEPTH));
  if (audit.blockedReason !== undefined) {
    await ports.uninstall(bundle.id).catch(() => undefined);
    return { ok: false, refused: `${audit.blockedReason}，已卸载。` };
  }
  const gate = confirmGate(bundle, audit, input);
  if (gate !== undefined) return gate;
  try {
    await ports.setEnabled(bundle.id, true);
  } catch (error: unknown) {
    return { ok: false, refused: errorText(error, '没能启用套件。') };
  }
  return { ok: true };
}

export async function uninstallBundle(
  ports: BundlePorts,
  pluginId: string,
): Promise<Omit<CatalogMutationResult, 'catalog'>> {
  let response: PluginListLike;
  try {
    response = await ports.listPlugins(ports.workspaceRoots());
  } catch (error: unknown) {
    return { ok: false, refused: errorText(error, '没能读取本机市场。') };
  }
  const bundle = listBundles(response, ports.kernelHome).bundles.find((b) => b.id === pluginId);
  if (bundle === undefined) return { ok: false, refused: '没有这个套件。' };
  try {
    await ports.uninstall(pluginId);
  } catch (error: unknown) {
    return { ok: false, refused: errorText(error, '套件没有卸载。') };
  }
  return { ok: true };
}

async function findBundle(
  ports: BundlePorts,
  marketplacePath: string,
  pluginName: string,
): Promise<
  | { readonly ok: true; readonly bundle: BundleRecord }
  | { readonly ok: false; readonly refused: string }
> {
  let response: PluginListLike;
  try {
    response = await ports.listPlugins(ports.workspaceRoots());
  } catch (error: unknown) {
    return { ok: false, refused: errorText(error, '没能读取本机市场。') };
  }
  const bundle = listBundles(response, ports.kernelHome).bundles.find(
    (b) => b.marketplacePath === marketplacePath && b.pluginName === pluginName,
  );
  if (bundle === undefined) return { ok: false, refused: '这个套件不在本机或工作区市场里。' };
  return { ok: true, bundle };
}

function confirmGate(
  bundle: BundleRecord,
  audit: BundleAudit,
  input: InstallBundleInput,
): Omit<CatalogMutationResult, 'catalog'> | undefined {
  if (audit.blockedReason !== undefined) return { ok: false, refused: audit.blockedReason };
  const needsAck = audit.level === 'p1' || audit.level === 'p2';
  if (needsAck && input.acknowledge !== true) {
    return {
      ok: false,
      needsConfirm: true,
      audit: {
        skillId: bundle.pluginName,
        subject: 'bundle',
        level: audit.level,
        findings: audit.findings.map((f) => f.detail),
        ...(audit.worstCase !== undefined ? { worstCase: audit.worstCase } : {}),
      },
    };
  }
  if (audit.level === 'p2' && input.confirmName !== bundle.pluginName) {
    return { ok: false, refused: `要安装高风险套件，请输入套件名「${bundle.pluginName}」确认。` };
  }
  return undefined;
}

/**
 * 内核装好的插件在 `<kernelHome>/plugins/cache/<市场名>/<插件名>/<版本>`
 * （`core-plugins/src/store.rs` 的 `plugin_root`）。版本不知道时，目录下只有一个版本才算找到。
 */
function installedDir(ports: BundlePorts, bundle: BundleRecord): string | undefined {
  const base = join(ports.kernelHome, 'plugins', 'cache', bundle.marketplaceId, bundle.pluginName);
  if (bundle.version !== undefined) {
    const dir = join(base, bundle.version);
    if (ports.io.readText(join(dir, '.codex-plugin', 'plugin.json')) !== undefined) return dir;
  }
  let entries: readonly { name: string; isDirectory: boolean }[] = [];
  try {
    entries = ports.io.readDir(base);
  } catch {
    return undefined;
  }
  const dirs = entries.filter((e) => e.isDirectory);
  return dirs.length === 1 && dirs[0] !== undefined ? join(base, dirs[0].name) : undefined;
}

function auditOf(ports: BundlePorts, bundle: BundleRecord): BundleAudit | undefined {
  if (bundle.source.kind === 'local') {
    return auditBundleFiles(ports.io.listFiles(bundle.source.path, BUNDLE_SCAN_DEPTH));
  }
  if (bundle.installed) {
    const dir = installedDir(ports, bundle);
    return dir !== undefined
      ? auditBundleFiles(ports.io.listFiles(dir, BUNDLE_SCAN_DEPTH))
      : undefined;
  }
  return undefined;
}

function toView(bundle: BundleRecord, audit: BundleAudit | undefined): CatalogBundleView {
  const remote = bundle.source.kind === 'git' || bundle.source.kind === 'npm';
  const unavailable =
    bundle.kernelUnavailableReason ??
    (audit?.blockedReason !== undefined && !bundle.installed ? audit.blockedReason : undefined) ??
    (bundle.source.kind === 'remote' || bundle.source.kind === 'unknown'
      ? '认不出这个套件的来源，EvoWork 无法在安装前检查它'
      : undefined);
  const host = bundleSourceHost(bundle.source);
  return {
    id: bundle.id,
    name: bundle.name,
    pluginName: bundle.pluginName,
    description: bundle.description,
    category: bundle.category,
    marketplaceName: bundle.marketplaceName,
    marketplacePath: bundle.marketplacePath,
    sourceLabel: bundleSourceLabel(bundle.source),
    installed: bundle.installed,
    enabled: bundle.enabled,
    ...(bundle.version !== undefined ? { version: bundle.version } : {}),
    available: unavailable === undefined,
    ...(unavailable !== undefined ? { disabledReason: unavailable } : {}),
    ...(remote && bundle.installed && !bundle.enabled ? { pendingReview: true } : {}),
    ...(remote && host !== undefined ? { sourceHost: host } : {}),
    ...(audit !== undefined
      ? {
          riskLevel: audit.level,
          riskLabel: riskLabel(audit.level),
          mcpServers: audit.mcpServers.map((s) => ({ name: s.name, transport: s.transport })),
        }
      : {}),
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}
