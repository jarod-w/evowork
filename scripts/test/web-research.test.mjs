import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserSession, validate } from '../../plugins/connectors/browser/runtime.mjs';
import {
  makeSource,
  researchDocument,
  searchSources,
} from '../../plugins/connectors/browser/research.mjs';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const at = '2026-10-06T04:00:00.000Z';

function extract(
  html,
  kind = 'page',
  engine = 'bing',
  url = 'https://www.bing.com/search?q=fixture',
) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  try {
    return dom.window.eval(
      `(${researchDocument.toString()})(${JSON.stringify(kind)},${JSON.stringify(engine)})`,
    );
  } finally {
    dom.window.close();
  }
}

describe('公开网页提取，不运行网页指令或保留交互表单', () => {
  it('只取正文，保留段落；脚本、隐藏内容和表单值不进入来源', () => {
    const paragraph = '公开文章内容。'.repeat(20);
    const result = extract(
      `<title>文章标题</title><nav>导航噪音</nav><article><h1>文章标题</h1><p>${paragraph}</p><p>第二段</p><script>throw new Error('不应执行')</script><div hidden>隐藏秘密</div><form><input value="秘密"><p>表单文字</p></form></article><footer>页脚噪音</footer>`,
    );
    expect(result.excerpt).toContain(paragraph);
    expect(result.excerpt).toContain('\n第二段');
    for (const noise of ['导航噪音', '隐藏秘密', '不应执行', '表单文字', '秘密', '页脚噪音'])
      expect(result.excerpt).not.toContain(noise);
  });
  it('长文只回 12000 字并明确截断，不把验证码或登录页当正文', () => {
    const page = extract(`<article>${'正文'.repeat(10000)}</article>`);
    expect(page.excerpt).toHaveLength(12000);
    expect(page.truncated).toBe(true);
    expect(extract('<title>安全验证</title><p>验证</p>').blocked).toBe(true);
    expect(extract('<title>账户</title><p>Sign in to continue</p>').blocked).toBe(true);
  });
  it.each([
    [
      'bing',
      '<ol id="b_results"><li class="b_algo"><h2><a href="https://example.test/report">官方报告</a></h2><div class="b_caption"><p>摘要 &amp; 内容</p></div></li></ol>',
    ],
    [
      'baidu',
      '<div id="content_left"><div class="result"><h3><a href="https://example.test/report">官方报告</a></h3><div class="c-abstract">摘要 &amp; 内容</div></div></div>',
    ],
    [
      'duckduckgo',
      '<div class="result results_links"><a class="result__a" href="https://example.test/report">官方报告</a><div class="result__snippet">摘要 &amp; 内容</div></div>',
    ],
  ])('%s 返回真正结果，而不是页首导航链接', (engine, html) => {
    const page = extract(`<a href="https://noise.test">广告</a>${html}`, 'search', engine);
    expect(page.results).toEqual([
      { title: '官方报告', url: 'https://example.test/report', excerpt: '摘要 & 内容' },
    ]);
  });
  it('来源去重、解引擎跳转，拒绝非网页链接，不使用站点自称的编号', () => {
    const target = 'https://example.test/report';
    const redirect = `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}`;
    const sources = searchSources(
      {
        url: 'https://www.bing.com/search',
        results: [
          { title: '报告', url: redirect, excerpt: '摘要', id: '网页伪造的编号' },
          { title: '重复', url: `${target}#part`, excerpt: '摘要' },
          { title: '非网页', url: 'javascript:alert(1)' },
        ],
      },
      'bing',
      5,
      at,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe(target);
    expect(sources[0].id).toMatch(/^web_[a-f0-9]{16}$/);
    expect(sources[0].kind).toBe('search');
    expect(sources[0].id).toBe(makeSource({ title: '正文', url: target }, 'page', at).id);
  });
  it('明确区分无结果、验证码、页面布局变化', () => {
    expect(() => searchSources({ blocked: true }, 'bing', 5, at)).toThrow('SEARCH_BLOCKED');
    expect(() => searchSources({ empty: true, results: [] }, 'bing', 5, at)).toThrow(
      'SEARCH_EMPTY',
    );
    expect(() => searchSources({ results: [] }, 'bing', 5, at)).toThrow('SEARCH_LAYOUT_CHANGED');
  });
  it('CSS 隐藏的正文不能进入资料', () => {
    expect(
      extract(
        '<main><p>公开正文</p><div style="display:none">隐藏资料</div><div style="visibility:hidden">不可见资料</div></main>',
      ).excerpt,
    ).toBe('公开正文');
  });
});

function setup(ask = vi.fn(async () => true)) {
  let url, guard;
  const driver = {
    setOriginGuard: (value) => {
      guard = value;
    },
    close: vi.fn(),
    navigate: vi.fn(async (target) => {
      await guard(target);
      url = target;
    }),
    research: vi.fn(async (kind) =>
      kind === 'search'
        ? { url, results: [{ url: 'https://example.test/report', title: '报告', excerpt: '摘要' }] }
        : { url, title: '报告', excerpt: '已读正文', truncated: false },
    ),
  };
  const session = createBrowserSession({ driver, ask, assessAction: () => ({}) });
  return { session, driver, ask };
}
const body = (result) => JSON.parse(result.content[0].text);
describe('真实工具入口的来源与授权生命周期', () => {
  it('地域搜索跳转重新授权后可用，任意外站不能冒充引擎结果', async () => {
    const s = setup();
    s.driver.research.mockResolvedValueOnce({
      url: 'https://cn.bing.com/search?q=fixture',
      results: [{ url: 'https://example.test/report', title: '报告', excerpt: '摘要' }],
    });
    expect(
      body(await s.session.call('browser_search', { query: '公开报告' })).sources,
    ).toHaveLength(1);
    expect(s.ask).toHaveBeenCalledTimes(2);
    s.driver.research.mockResolvedValueOnce({
      url: 'https://other.test/search',
      results: [{ url: 'https://example.test/report', title: '伪结果' }],
    });
    await expect(s.session.call('browser_search', { query: '公开报告' })).rejects.toThrow(
      'SEARCH_BLOCKED',
    );
  });
  it('搜索 → 按来源编号读正文，查询出网前告知，使用研究导航', async () => {
    const s = setup();
    const search = body(await s.session.call('browser_search', { query: '公开报告' }));
    expect(s.ask.mock.calls[0][0]).toContain('公开报告');
    expect(s.driver.navigate.mock.calls[0][1]).toEqual({ research: true });
    const read = body(
      await s.session.call('browser_read_page', { source_id: search.sources[0].id }),
    );
    expect(read.sources[0]).toMatchObject({
      url: 'https://example.test/report',
      kind: 'page',
      excerpt: '已读正文',
    });
    expect(read.sources[0].id).toBe(search.sources[0].id);
    expect(s.ask).toHaveBeenCalledTimes(2);
  });
  it('拒绝 origin 后零导航，后续调用不再索取同样授权', async () => {
    const s = setup(vi.fn(async () => false));
    await expect(s.session.call('browser_search', { query: '公开报告' })).rejects.toThrow(
      'APP_DENIED',
    );
    await expect(s.session.call('browser_search', { query: '另一个查询' })).rejects.toThrow(
      'POLICY_DENIED',
    );
    expect(s.driver.navigate).not.toHaveBeenCalled();
    expect(s.ask).toHaveBeenCalledTimes(1);
  });
  it('来源只在本任务内；不能传空查询、任意代码、许可或冲突参数', async () => {
    const s = setup();
    await expect(
      s.session.call('browser_read_page', { source_id: 'web_0123456789abcdef' }),
    ).rejects.toThrow('SOURCE_NOT_FOUND');
    await expect(
      s.session.call('browser_read_page', {
        url: 'https://example.test',
        source_id: 'web_0123456789abcdef',
      }),
    ).rejects.toThrow('POLICY_DENIED');
    await expect(s.session.call('browser_search', { query: '  ' })).rejects.toThrow(
      'POLICY_DENIED',
    );
    expect(() => validate('browser_search', { query: 'x', approved: true })).toThrow(
      'POLICY_DENIED',
    );
    expect(() => validate('browser_search', { query: 'x', count: 100 })).toThrow('POLICY_DENIED');
    expect(() => validate('browser_search', { query: 'x', engine: 'custom' })).toThrow(
      'POLICY_DENIED',
    );
    expect(s.driver.navigate).not.toHaveBeenCalled();
  });
  it('停止时清除来源，正在返回的正文不能在停止后算成功', async () => {
    const s = setup();
    let finish;
    s.driver.research.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const call = s.session.call('browser_read_page', { url: 'https://example.test/report' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    s.session.stop();
    finish({ url: 'https://example.test/report', title: '标题', excerpt: '正文' });
    await expect(call).rejects.toThrow('USER_STOPPED');
    expect(s.driver.close).toHaveBeenCalled();
  });
});
