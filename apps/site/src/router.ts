import type { Locale, PlatformId, RouteState } from './types.js';

const LOCALE_STORAGE_KEY = 'evowork.site.locale';

export function detectDefaultLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // 忽略存储受限环境
  }
  const lang = (navigator.language || '').toLowerCase();
  return lang.startsWith('en') ? 'en' : 'zh';
}

export function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 忽略存储受限环境
  }
}

export function detectPlatform(): PlatformId {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const raw = (
    nav.userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ''
  ).toLowerCase();
  if (raw.includes('win')) return 'windows';
  return 'macos';
}

export function buildPath(route: RouteState): string {
  const base = `/${route.locale}`;
  if (route.page === 'home') return `${base}/`;
  if (route.page === 'docs') {
    return route.docSlug ? `${base}/docs/${encodeURIComponent(route.docSlug)}` : `${base}/docs`;
  }
  return `${base}/${route.page}`;
}

export function parseRoute(
  pathname: string,
  fallbackLocale: Locale = detectDefaultLocale(),
): RouteState {
  const cleaned = pathname.replace(/\/+$/, '') || '/';
  const segments = cleaned.split('/').filter(Boolean);

  let locale: Locale = fallbackLocale;
  let offset = 0;
  if (segments[0] === 'zh' || segments[0] === 'en') {
    locale = segments[0];
    offset = 1;
  }

  const head = segments[offset];
  if (!head) {
    return { locale, page: 'home' };
  }
  if (head === 'download') {
    return { locale, page: 'download' };
  }
  if (head === 'enterprise') {
    return { locale, page: 'enterprise' };
  }
  if (head === 'docs') {
    const rawSlug = segments[offset + 1];
    const slug = rawSlug ? decodeURIComponent(rawSlug) : undefined;
    return { locale, page: 'docs', docSlug: slug };
  }
  return { locale, page: 'home' };
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 回退到 execCommand
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.className = 'ew-sr-only';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
