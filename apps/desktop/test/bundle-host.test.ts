/**
 * 「套件」的安装前审计（13 §9 / §9.1）。真实临时目录 + 假的内核端口：
 * 断的是「装之前看过它能做什么」这件事，不是某个调用顺序长什么样 ——
 * 但 git / npm 那条路的顺序本身就是承诺（装之前预写停用、审计过了才启用），所以它要钉住。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isKernelSyncedPath, type PluginListLike } from '@evowork/catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installBundle,
  readBundles,
  uninstallBundle,
  type BundlePorts,
} from '../src/main/bundle-host.js';
import { createFsCatalogIo } from '../src/main/catalog-host.js';

let root: string;
let kernelHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ew-bundle-host-'));
  kernelHome = join(root, 'kernel');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePlugin(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
}

const MANIFEST = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version: '1.0.0', ...extra });

const SKILL = '---\nname: s\ndescription: 写摘要\n---\n只读说明\n';

interface Plugin {
  readonly name: string;
  readonly source: unknown;
  installed?: boolean;
  enabled?: boolean;
  readonly version?: string;
}

function harness(markets: { name: string; path: string; plugins: Plugin[] }[]) {
  const calls: string[] = [];
  const state = new Map<string, Plugin>();
  for (const m of markets) for (const p of m.plugins) state.set(`${p.name}@${m.name}`, p);
  const response = (): PluginListLike => ({
    marketplaces: markets.map((m) => ({
      name: m.name,
      path: m.path,
      plugins: m.plugins.map((p) => ({
        id: `${p.name}@${m.name}`,
        name: p.name,
        source: p.source,
        installed: p.installed === true,
        enabled: p.enabled === true,
        version: p.version ?? null,
        installPolicy: 'AVAILABLE',
      })),
    })),
    marketplaceLoadErrors: [],
  });
  const onInstall = vi.fn<(id: string) => void>();
  const ports: BundlePorts = {
    kernelHome,
    io: createFsCatalogIo(),
    listPlugins: vi.fn(async () => response()),
    install: vi.fn(async (input) => {
      const market = markets.find((m) => m.path === input.marketplacePath);
      const id = `${input.pluginName}@${market?.name ?? '?'}`;
      calls.push(`install ${id}`);
      onInstall(id);
      const p = state.get(id);
      if (p) {
        p.installed = true;
        // 内核装完无条件写成启用（core-plugins/src/manager.rs:2256，13 §12 V6）
        p.enabled = true;
      }
    }),
    uninstall: vi.fn(async (id) => {
      calls.push(`uninstall ${id}`);
      const p = state.get(id);
      if (p) {
        p.installed = false;
        p.enabled = false;
      }
    }),
    setEnabled: vi.fn(async (id, enabled) => {
      calls.push(`enabled ${id} ${String(enabled)}`);
      const p = state.get(id);
      if (p) p.enabled = enabled;
    }),
    workspaceRoots: () => ['/workspace'],
  };
  return { ports, calls, onInstall };
}

describe('「套件」Tab 只出现本机与工作区市场（13 §9）', () => {
  it('渲染层收到的任何套件，其 marketplacePath 都不在 <kernelHome>/.tmp/ 之下', async () => {
    const { ports } = harness([
      {
        name: 'openai-api-curated',
        path: join(kernelHome, '.tmp/plugins/.agents/plugins/api_marketplace.json'),
        plugins: [
          { name: 'airtable', source: { type: 'local', path: join(kernelHome, '.tmp/p') } },
        ],
      },
      {
        name: 'openai-curated',
        path: join(kernelHome, '.tmp/plugins/.agents/plugins/marketplace.json'),
        plugins: [{ name: 'figma', source: { type: 'local', path: join(kernelHome, '.tmp/f') } }],
      },
      {
        name: 'mine',
        path: join(root, 'market/marketplace.json'),
        plugins: [{ name: 'ok', source: { type: 'local', path: join(root, 'market/ok') } }],
      },
    ]);
    const { bundles } = await readBundles(ports);
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) {
      expect(isKernelSyncedPath(bundle.marketplacePath ?? '', kernelHome)).toBe(false);
    }
  });

  it('工作区市场：把项目根目录传给内核', async () => {
    const { ports } = harness([]);
    await readBundles(ports);
    expect(ports.listPlugins).toHaveBeenCalledWith(['/workspace']);
  });

  it('读市场失败写进 bundleErrors，不吞成空列表（不静默降级）', async () => {
    const { ports } = harness([]);
    const failing: BundlePorts = {
      ...ports,
      listPlugins: async () => {
        throw new Error('chatgpt authentication required for remote plugin catalog');
      },
    };
    const result = await readBundles(failing);
    expect(result.bundles).toEqual([]);
    expect(result.bundleErrors[0]?.message).toMatch(/没能读取本机市场/);
  });

  it('渲染层直接传内核同步目录的路径来装，也装不上', async () => {
    const curatedPath = join(kernelHome, '.tmp/plugins/.agents/plugins/api_marketplace.json');
    const { ports, onInstall } = harness([
      {
        name: 'openai-api-curated',
        path: curatedPath,
        plugins: [
          { name: 'airtable', source: { type: 'local', path: join(kernelHome, '.tmp/p') } },
        ],
      },
    ]);
    const result = await installBundle(ports, {
      marketplacePath: curatedPath,
      pluginName: 'airtable',
      acknowledge: true,
      confirmName: 'airtable',
    });
    expect(result.ok).toBe(false);
    expect(onInstall).not.toHaveBeenCalled();
  });
});

describe('本机来源：先审后装（9.1 第 1 条）', () => {
  function localMarket(files: Record<string, string>) {
    const dir = join(root, 'market', 'demo');
    writePlugin(dir, files);
    return harness([
      {
        name: 'mine',
        path: join(root, 'market', 'marketplace.json'),
        plugins: [{ name: 'demo', source: { type: 'local', path: dir } }],
      },
    ]);
  }
  const input = { marketplacePath: '', pluginName: 'demo' };
  const withPath = () => ({ ...input, marketplacePath: join(root, 'market', 'marketplace.json') });

  it('只有说明文字的技能 → P0，直接装；卡片标「本地目录」', async () => {
    const { ports, onInstall } = localMarket({
      '.codex-plugin/plugin.json': MANIFEST('demo'),
      'skills/s/SKILL.md': SKILL,
    });
    const view = (await readBundles(ports)).bundles[0];
    expect(view?.sourceLabel).toBe('本地目录');
    expect(view?.riskLevel).toBe('p0');
    const result = await installBundle(ports, withPath());
    expect(result.ok).toBe(true);
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it('带脚本 → P1：没勾「我已了解」就不调 plugin/install', async () => {
    const { ports, onInstall } = localMarket({
      '.codex-plugin/plugin.json': MANIFEST('demo'),
      'skills/s/SKILL.md': SKILL,
      'skills/s/run.py': 'print(1)\n',
    });
    const first = await installBundle(ports, withPath());
    expect(first.needsConfirm).toBe(true);
    expect(first.audit).toMatchObject({ subject: 'bundle', level: 'p1', skillId: 'demo' });
    expect(onInstall).not.toHaveBeenCalled();
    expect((await installBundle(ports, { ...withPath(), acknowledge: true })).ok).toBe(true);
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it('插件里的 stdio MCP → P2：确认卡逐个列出 server，不输名字不装', async () => {
    const { ports, onInstall } = localMarket({
      '.codex-plugin/plugin.json': MANIFEST('demo'),
      '.mcp.json': JSON.stringify({ mcpServers: { tracker: { command: 'node', args: ['s.js'] } } }),
    });
    const first = await installBundle(ports, withPath());
    expect(first.audit?.level).toBe('p2');
    expect(first.audit?.findings.join('\n')).toMatch(/tracker/);
    expect(first.audit?.worstCase).toMatch(/以你的身份/);
    const noName = await installBundle(ports, { ...withPath(), acknowledge: true });
    expect(noName.ok).toBe(false);
    expect(onInstall).not.toHaveBeenCalled();
    const ok = await installBundle(ports, {
      ...withPath(),
      acknowledge: true,
      confirmName: 'demo',
    });
    expect(ok.ok).toBe(true);
  });

  it('带应用连接器的不可安装：卡片上就写原因，确认了也装不上', async () => {
    const { ports, onInstall } = localMarket({
      '.codex-plugin/plugin.json': MANIFEST('demo', { apps: './.app.json' }),
      '.app.json': '{"apps":{"a":{"id":"asdk_app_1"}}}',
    });
    const view = (await readBundles(ports)).bundles[0];
    expect(view?.available).toBe(false);
    expect(view?.disabledReason).toMatch(/不支持的应用连接器/);
    const result = await installBundle(ports, {
      ...withPath(),
      acknowledge: true,
      confirmName: 'demo',
    });
    expect(result.ok).toBe(false);
    expect(onInstall).not.toHaveBeenCalled();
  });
});

describe('git / npm 来源：先装后审（9.1 第 2 条，HUB-Q8a=B）', () => {
  const MARKET = () => join(root, 'market', 'marketplace.json');

  function gitMarket(installedFiles: Record<string, string>) {
    const h = harness([
      {
        name: 'mine',
        path: MARKET(),
        plugins: [{ name: 'demo', source: { type: 'git', url: 'https://github.com/o/r.git' } }],
      },
    ]);
    // 内核装好后的落盘位置：plugins/cache/<市场>/<插件>/<版本>
    h.onInstall.mockImplementation(() => {
      writePlugin(join(kernelHome, 'plugins/cache/mine/demo/1.0.0'), installedFiles);
    });
    return h;
  }

  it('内核装完会把它写成启用（V6）：审计结论出来之前立刻压回停用', async () => {
    const { ports, calls } = gitMarket({
      '.codex-plugin/plugin.json': MANIFEST('demo'),
      'skills/s/SKILL.md': SKILL,
      'skills/s/run.py': 'print(1)\n',
    });
    const first = await installBundle(ports, { marketplacePath: MARKET(), pluginName: 'demo' });
    expect(calls.slice(0, 2)).toEqual(['install demo@mine', 'enabled demo@mine false']);
    // P1：停在「待确认」，没有启用
    expect(first.needsConfirm).toBe(true);
    expect(calls).not.toContain('enabled demo@mine true');
    const view = (await readBundles(ports)).bundles[0];
    expect(view?.pendingReview).toBe(true);
    expect(view?.sourceLabel).toBe('Git');

    const second = await installBundle(ports, {
      marketplacePath: MARKET(),
      pluginName: 'demo',
      acknowledge: true,
    });
    expect(second.ok).toBe(true);
    expect(calls.at(-1)).toBe('enabled demo@mine true');
    expect(calls.filter((c) => c.startsWith('install'))).toHaveLength(1);
  });

  it('装下来的内容带应用连接器 → 立刻卸载，并说明原因', async () => {
    const { ports, calls } = gitMarket({
      '.codex-plugin/plugin.json': MANIFEST('demo', { apps: './.app.json' }),
      '.app.json': '{"apps":{"a":{"id":"asdk_app_1"}}}',
    });
    const result = await installBundle(ports, { marketplacePath: MARKET(), pluginName: 'demo' });
    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/已卸载/);
    expect(calls).toContain('uninstall demo@mine');
    expect(calls).not.toContain('enabled demo@mine true');
  });

  it('P0 内容审计通过直接启用', async () => {
    const { ports, calls } = gitMarket({
      '.codex-plugin/plugin.json': MANIFEST('demo'),
      'skills/s/SKILL.md': SKILL,
    });
    const result = await installBundle(ports, { marketplacePath: MARKET(), pluginName: 'demo' });
    expect(result.ok).toBe(true);
    expect(calls.at(-1)).toBe('enabled demo@mine true');
  });

  it('找不到落盘目录就没法审 → 卸载，不留一个没看过的插件', async () => {
    const h = harness([
      {
        name: 'mine',
        path: MARKET(),
        plugins: [{ name: 'demo', source: { type: 'git', url: 'https://github.com/o/r.git' } }],
      },
    ]);
    const result = await installBundle(h.ports, { marketplacePath: MARKET(), pluginName: 'demo' });
    expect(result.ok).toBe(false);
    expect(h.calls).toContain('uninstall demo@mine');
  });

  it('内核取不到内容时，如实说要能访问哪台主机', async () => {
    const h = harness([
      {
        name: 'mine',
        path: MARKET(),
        plugins: [{ name: 'demo', source: { type: 'git', url: 'https://github.com/o/r.git' } }],
      },
    ]);
    const failing: BundlePorts = {
      ...h.ports,
      install: async () => {
        throw new Error('failed to clone');
      },
    };
    const result = await installBundle(failing, { marketplacePath: MARKET(), pluginName: 'demo' });
    expect(result.refused).toMatch(/需要能访问 github\.com/);
  });

  it('卸载只认列表里的套件', async () => {
    const { ports } = harness([]);
    expect((await uninstallBundle(ports, 'airtable@openai-api-curated')).ok).toBe(false);
  });
});
