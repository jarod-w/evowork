import { createHash } from 'node:crypto';

export const SEARCH_ENGINES = {
  bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  baidu: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  duckduckgo: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
};

/** 仅接受引擎的已知搜索入口；地域跳转仍须经过逐 origin 授权。 */
export function isSearchPage(input, engine) {
  const url = sourceUrl(input);
  if (!url) return false;
  const parsed = new URL(url);
  const entries = {
    bing: [['www.bing.com', 'cn.bing.com', 'bing.com'], '/search'],
    baidu: [['www.baidu.com', 'baidu.com'], '/s'],
    duckduckgo: [['html.duckduckgo.com'], '/html/'],
  }[engine];
  return Boolean(entries && entries[0].includes(parsed.hostname) && parsed.pathname === entries[1]);
}

export const RESEARCH_ERRORS = {
  SEARCH_BLOCKED: '搜索网站要求验证码或登录，未取得可用结果。',
  SEARCH_LAYOUT_CHANGED: '未能识别搜索页面的结果列表，可以显式换一个搜索引擎。',
  SEARCH_EMPTY: '没有找到匹配的搜索结果，可以调整查询词。',
  PAGE_BLOCKED: '网页要求验证码或登录，未取得正文。',
  PAGE_EMPTY: '未取得可用正文；可能需要登录或由脚本加载。',
  PAGE_HTTP_ERROR: '网站返回了访问错误，未取得可用来源。',
  PAGE_UNSUPPORTED: '当前仅支持 HTML 与纯文本网页，请使用文件工具读取其它格式。',
  NAVIGATION_FAILED: '无法连接到网页，请检查网络或稍后重试。',
  APP_DENIED: '你已拒绝访问该网站，未读取资料。',
  POLICY_DENIED: '请求被策略拦截或参数无效，未取得可用资料。',
  USER_STOPPED: '浏览器任务已停止，未继续读取资料。',
  SOURCE_NOT_FOUND: '这个来源编号不在当前任务中，请重新搜索或提供网页 URL。',
  TIMEOUT: '网页读取超时，未取得完整内容。',
  BROWSER_UNAVAILABLE: '没有找到可用的 Chrome / Chromium，无法联网搜索。',
};

export function sourceUrl(input, base) {
  if (typeof input !== 'string' || !input.trim() || input.length > 8192) return;
  try {
    const url = new URL(input, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return url.href;
  } catch {
    return;
  }
}

/** Bing 的跳转链接携带 base64 目标；只解它规定的参数，不把别的跳转当目标。 */
function resultUrl(input, base, engine) {
  let url = sourceUrl(input, base);
  if (!url) return;
  const parsed = new URL(url);
  if (
    engine === 'bing' &&
    /(^|\.)bing\.com$/.test(parsed.hostname) &&
    parsed.pathname === '/ck/a'
  ) {
    const encoded = parsed.searchParams.get('u');
    if (!encoded?.startsWith('a1')) return;
    url = sourceUrl(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
  }
  if (
    engine === 'duckduckgo' &&
    /(^|\.)duckduckgo\.com$/.test(parsed.hostname) &&
    parsed.searchParams.has('uddg')
  ) {
    url = sourceUrl(parsed.searchParams.get('uddg'));
  }
  return url;
}

export function makeSource(raw, kind, at) {
  const url = sourceUrl(raw.url);
  if (!url || typeof raw.title !== 'string') return;
  return {
    id: `web_${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
    url,
    title: raw.title.trim().slice(0, 300) || new URL(url).hostname,
    kind,
    retrievedAt: at,
    excerpt: String(raw.excerpt ?? '').slice(0, kind === 'page' ? 12000 : 1500),
    truncated: raw.truncated === true,
  };
}

export function searchSources(snapshot, engine, count, at) {
  if (snapshot.blocked) throw new Error('SEARCH_BLOCKED');
  if (!snapshot.results?.length)
    throw new Error(snapshot.empty ? 'SEARCH_EMPTY' : 'SEARCH_LAYOUT_CHANGED');
  const sources = new Map();
  for (const result of snapshot.results) {
    const url = resultUrl(result.url, snapshot.url, engine);
    const source = url && makeSource({ ...result, url }, 'search', at);
    if (source) sources.set(source.url, source);
    if (sources.size >= count) break;
  }
  if (!sources.size) throw new Error('SEARCH_LAYOUT_CHANGED');
  return [...sources.values()];
}

/** 固定读取函数由 CDP 在隔离 world 执行。模型不能传 selector 或 JavaScript。 */
/* global document, location, getComputedStyle */
export function researchDocument(kind, engine) {
  const clean = (value) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const visible = (element) => {
    if (!element || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const whole = clean(document.body?.innerText ?? document.body?.textContent).slice(0, 100000);
  const blocked = Boolean(
    document.querySelector('form#challenge-form, #anomaly-modal, iframe[src*="captcha"]') ||
    /captcha|人机验证|安全验证|verify you are human|unusual traffic|access denied|robot check/i.test(
      document.title,
    ) ||
    (whole.length < 2500 &&
      /verify you are human|请输入验证码|请完成安全验证|访问过于频繁/i.test(whole)),
  );
  const base = { url: location.href, title: clean(document.title), blocked };
  if (kind === 'search') {
    const selectors = {
      bing: ['#b_results .b_algo', 'h2 a', '.b_caption p, .b_snippet'],
      baidu: [
        '#content_left .result, #content_left .c-container',
        'h3 a',
        '.c-abstract, .content-right_8Zs40, .c-span-last',
      ],
      duckduckgo: ['.result.results_links', '.result__a', '.result__snippet'],
    }[engine];
    const results = [...document.querySelectorAll(selectors[0])].slice(0, 30).flatMap((node) => {
      const link = node.querySelector(selectors[1]);
      if (!link || !visible(node)) return [];
      return [
        {
          title: clean(link.textContent),
          url: link.href,
          excerpt: clean(node.querySelector(selectors[2])?.textContent).slice(0, 1500),
        },
      ];
    });
    return {
      ...base,
      results,
      empty: /没有找到|未找到|no results found|there are no results/i.test(whole),
    };
  }
  const root =
    [...document.querySelectorAll('article, main, [role="main"]')].find(
      (node) => visible(node) && clean(node.textContent).length >= 100,
    ) ?? document.body;
  if (!root) return { ...base, excerpt: '', truncated: false };
  const copy = root.cloneNode(true);
  const originals = [...root.querySelectorAll('*')];
  const copies = [...copy.querySelectorAll('*')];
  originals.forEach((node, index) => {
    if (!visible(node)) copies[index].remove();
  });
  copy
    .querySelectorAll(
      'script, style, noscript, template, nav, header, footer, aside, form, button, input, textarea, select, iframe, svg, [hidden], [aria-hidden="true"]',
    )
    .forEach((node) => node.remove());
  copy.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  copy
    .querySelectorAll('p, div, section, h1, h2, h3, h4, li, tr, pre, blockquote')
    .forEach((node) => node.append('\n'));
  const content = (copy.textContent ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const login =
    whole.length < 2500 &&
    /sign in to continue|log in to continue|登录后查看|登录后阅读|请先登录/i.test(whole);
  return {
    ...base,
    blocked: blocked || login,
    excerpt: content.slice(0, 12000),
    truncated: content.length > 12000,
  };
}
