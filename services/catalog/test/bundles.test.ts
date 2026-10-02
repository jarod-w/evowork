import { describe, expect, it } from 'vitest';

import {
  auditBundleFiles,
  BUNDLE_APPS_REFUSAL,
  isKernelSyncedPath,
  listBundles,
  parseBundleSource,
  type PluginListLike,
} from '../src/bundles.js';

const KERNEL = '/home/u/.evowork/kernel';

function plugin(name: string, source: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: `${name}@m`,
    name,
    source,
    installed: false,
    enabled: false,
    installPolicy: 'AVAILABLE',
    ...extra,
  };
}

describe('「套件」只列本机与工作区市场（13 §9，HUB-Q8=B）', () => {
  it('内核同步进 <kernelHome>/.tmp/ 的市场一律不进产品 —— 判路径这一类，不判名字', () => {
    const response: PluginListLike = {
      marketplaces: [
        // 名字换了、以后再多一个，照样滤掉
        {
          name: 'openai-api-curated',
          path: `${KERNEL}/.tmp/plugins/.agents/plugins/api_marketplace.json`,
          plugins: [plugin('airtable', { type: 'local', path: `${KERNEL}/.tmp/plugins/a` })],
        },
        {
          name: 'some-future-name',
          path: `${KERNEL}/.tmp/other/marketplace.json`,
          plugins: [plugin('x', { type: 'local', path: '/elsewhere/x' })],
        },
        {
          name: 'mine',
          path: '/home/u/my-market/.agents/plugins/marketplace.json',
          plugins: [plugin('ok', { type: 'local', path: '/home/u/my-market/ok' })],
        },
      ],
      marketplaceLoadErrors: [
        { marketplacePath: `${KERNEL}/.tmp/plugins/broken.json`, message: 'x' },
        { marketplacePath: '/home/u/bad/marketplace.json', message: '解析失败' },
      ],
    };
    const { bundles, errors } = listBundles(response, KERNEL);
    expect(bundles.every((b) => !isKernelSyncedPath(b.marketplacePath, KERNEL))).toBe(true);
    expect(bundles.map((b) => b.pluginName)).toEqual(['ok']);
    // 我们自己的市场加载失败要如实写出来；内核同步那条通道的错误不该漏到产品里
    expect(errors).toEqual([{ path: '/home/u/bad/marketplace.json', message: '解析失败' }]);
  });

  it('本机市场里指向 .tmp 的插件同样滤掉（市场在外面、内容在里面也不行）', () => {
    const { bundles } = listBundles(
      {
        marketplaces: [
          {
            name: 'mine',
            path: '/home/u/m/marketplace.json',
            plugins: [plugin('sneaky', { type: 'local', path: `${KERNEL}/.tmp/plugins/x` })],
          },
        ],
        marketplaceLoadErrors: [],
      },
      KERNEL,
    );
    expect(bundles).toEqual([]);
  });

  it('`..` 绕不过路径判断', () => {
    expect(isKernelSyncedPath(`${KERNEL}/skills/../.tmp/plugins/m.json`, KERNEL)).toBe(true);
    expect(isKernelSyncedPath(`${KERNEL}/.tmpfoo/m.json`, KERNEL)).toBe(false);
    expect(isKernelSyncedPath(`${KERNEL}/plugins/cache/m`, KERNEL)).toBe(false);
  });

  it('没有本机路径的市场不列，但要说出来（不静默）', () => {
    const { bundles, errors } = listBundles(
      {
        marketplaces: [
          { name: 'remote-ish', path: null, plugins: [plugin('a', { type: 'remote' })] },
        ],
        marketplaceLoadErrors: [],
      },
      KERNEL,
    );
    expect(bundles).toEqual([]);
    expect(errors[0]?.message).toMatch(/没有本机路径/);
  });

  it('source 三种都认得，认不出来的不当成本机', () => {
    expect(parseBundleSource({ type: 'local', path: '/a' })).toEqual({ kind: 'local', path: '/a' });
    expect(parseBundleSource({ type: 'git', url: 'https://g/x.git', sha: 'abc' }).kind).toBe('git');
    expect(parseBundleSource({ type: 'npm', package: '@a/b' }).kind).toBe('npm');
    expect(parseBundleSource({ type: 'local' }).kind).toBe('unknown');
    expect(parseBundleSource(null).kind).toBe('unknown');
  });
});

describe('套件的安装前审计（13 §9.1）', () => {
  const manifest = (extra: Record<string, unknown> = {}) => ({
    relativePath: '.codex-plugin/plugin.json',
    text: JSON.stringify({
      name: 'demo',
      interface: { websiteURL: 'https://example.com', privacyPolicyURL: 'https://example.com/p' },
      ...extra,
    }),
  });

  it('纯技能的插件包与技能同一套规则：只有说明文字 → P0，manifest 里的官网链接不算出网', () => {
    const audit = auditBundleFiles([
      manifest(),
      { relativePath: 'skills/a/SKILL.md', text: '---\nname: a\ndescription: d\n---\n写个摘要' },
    ]);
    expect(audit.level).toBe('p0');
    expect(audit.blockedReason).toBeUndefined();
  });

  it('带应用连接器的不可安装，原因里没有 ChatGPT 字样（K7 / K5）', () => {
    const audit = auditBundleFiles([
      manifest({ apps: './.app.json' }),
      { relativePath: '.app.json', text: '{"apps":{"x":{"id":"asdk_app_1"}}}' },
    ]);
    expect(audit.blockedReason).toBe(BUNDLE_APPS_REFUSAL);
    expect(audit.blockedReason).not.toMatch(/chatgpt|openai/i);
  });

  it('manifest 没写 apps、但默认位置有 .app.json，同样不可安装', () => {
    const audit = auditBundleFiles([
      manifest(),
      { relativePath: '.app.json', text: '{"apps":{"x":{"id":"asdk_app_1"}}}' },
    ]);
    expect(audit.blockedReason).toBe(BUNDLE_APPS_REFUSAL);
  });

  it('插件里的 stdio MCP 是 P2，逐个列出；远程 MCP 是 P1 并写出主机', () => {
    const audit = auditBundleFiles([
      manifest(),
      {
        relativePath: '.mcp.json',
        text: JSON.stringify({
          mcpServers: {
            local: { command: 'node', args: ['server.js'] },
            sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
          },
        }),
      },
    ]);
    expect(audit.level).toBe('p2');
    expect(audit.worstCase).toMatch(/以你的身份/);
    expect(audit.mcpServers.map((s) => [s.name, s.transport])).toEqual([
      ['local', 'stdio'],
      ['sentry', 'http'],
    ]);
    expect(audit.findings.some((f) => f.detail.includes('mcp.sentry.dev'))).toBe(true);
  });

  it('只有远程 MCP → P1，不是 P0（会出网）', () => {
    const audit = auditBundleFiles([
      manifest({ mcpServers: { s: { type: 'http', url: 'https://x.example/mcp' } } }),
    ]);
    expect(audit.level).toBe('p1');
  });

  it('inline hooks 也是 P2', () => {
    const audit = auditBundleFiles([manifest({ hooks: [{ hooks: {} }] })]);
    expect(audit.level).toBe('p2');
    expect(audit.findings.some((f) => f.code === 'hooks')).toBe(true);
  });

  it('找不到 plugin.json → P2（能力面未知），不是 P0', () => {
    const audit = auditBundleFiles([{ relativePath: 'README.md', text: 'hi' }]);
    expect(audit.level).toBe('p2');
  });
});
