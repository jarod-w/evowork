import { useCallback, useEffect, useMemo, useState } from 'react';

import { FloatingPillNav } from './components/FloatingPillNav.js';
import { MinimalFooter } from './components/Sections.js';
import { getSiteContent } from './content/index.js';
import { DocsPage } from './pages/DocsPage.js';
import { DownloadPage } from './pages/DownloadPage.js';
import { EnterprisePage } from './pages/EnterprisePage.js';
import { HomePage } from './pages/HomePage.js';
import {
  buildPath,
  detectDefaultLocale,
  detectPlatform,
  parseRoute,
  persistLocale,
} from './router.js';
import type { Locale, PageId, PlatformId, RouteState } from './types.js';

export interface AppProps {
  readonly initialRoute?: RouteState | undefined;
  readonly platformOverride?: PlatformId | undefined;
  readonly showMacUnsignedGuide?: boolean | undefined;
  readonly leadEndpoint?: string | undefined;
}

export function App({
  initialRoute,
  platformOverride,
  showMacUnsignedGuide,
  leadEndpoint,
}: AppProps = {}) {
  const [route, setRoute] = useState<RouteState>(
    () => initialRoute ?? parseRoute(window.location.pathname, detectDefaultLocale()),
  );
  const platform = useMemo<PlatformId>(
    () => platformOverride ?? detectPlatform(),
    [platformOverride],
  );
  const content = useMemo(() => getSiteContent(route.locale), [route.locale]);

  useEffect(() => {
    document.title = content.meta.pageTitles[route.page];
    document.documentElement.lang = content.htmlLang;
  }, [content, route.page]);

  useEffect(() => {
    function handlePopState() {
      setRoute(parseRoute(window.location.pathname, detectDefaultLocale()));
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback(
    (page: PageId, docSlug?: string, anchor?: string) => {
      const next: RouteState = { locale: route.locale, page, docSlug };
      setRoute(next);
      const nextPath = buildPath(next) + (anchor ? `#${anchor}` : '');
      if (window.location.pathname !== buildPath(next) || anchor) {
        window.history.pushState(null, '', nextPath);
      }
      if (anchor) {
        window.requestAnimationFrame(() => {
          document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' });
        });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [route.locale],
  );

  const switchLocale = useCallback((nextLocale: Locale) => {
    persistLocale(nextLocale);
    setRoute((prev) => {
      const next: RouteState = { ...prev, locale: nextLocale };
      window.history.pushState(null, '', buildPath(next));
      return next;
    });
  }, []);

  return (
    <div className="ews-shell">
      <FloatingPillNav
        content={content}
        activePage={route.page}
        platform={platform}
        onNavigate={navigate}
        onSwitchLocale={switchLocale}
      />

      <main className="ews-main">
        {route.page === 'home' && (
          <HomePage content={content} platform={platform} onNavigate={navigate} />
        )}
        {route.page === 'download' && (
          <DownloadPage
            content={content}
            platform={platform}
            onNavigate={navigate}
            showMacUnsignedGuide={showMacUnsignedGuide}
          />
        )}
        {route.page === 'docs' && (
          <DocsPage content={content} docSlug={route.docSlug} onNavigate={navigate} />
        )}
        {route.page === 'enterprise' && (
          <EnterprisePage content={content} onNavigate={navigate} leadEndpoint={leadEndpoint} />
        )}
      </main>

      <MinimalFooter content={content} onNavigate={navigate} />
    </div>
  );
}
