import { useState } from 'react';

import { SITE_CONFIG } from '../config.js';
import { buildPath } from '../router.js';
import type { Locale, PageId, PlatformId, SiteContent } from '../types.js';
import { BrandMark, SiteIcon } from './icons.js';

export interface FloatingPillNavProps {
  readonly content: SiteContent;
  readonly activePage: PageId;
  readonly platform: PlatformId;
  readonly onNavigate: (page: PageId, docSlug?: string, anchor?: string) => void;
  readonly onSwitchLocale: (next: Locale) => void;
}

/**
 * B1: 悬浮胶囊导航栏。
 * 参考 doubao.com/work 的居中悬浮毛玻璃胶囊布局，针对 EvoWork 增加双语切换、
 * 账号外链与移动端抽屉菜单。
 */
export function FloatingPillNav({
  content,
  activePage,
  platform,
  onNavigate,
  onSwitchLocale,
}: FloatingPillNavProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const nextLocale: Locale = content.locale === 'zh' ? 'en' : 'zh';

  function handleNavClick(page: PageId, docSlug?: string, anchor?: string) {
    setMobileOpen(false);
    onNavigate(page, docSlug, anchor);
  }

  return (
    <header className="ews-nav-wrap">
      <div className="ews-nav-pill" role="navigation" aria-label={content.meta.siteName}>
        <a
          className="ews-nav-brand"
          href={buildPath({ locale: content.locale, page: 'home' })}
          onClick={(e) => {
            e.preventDefault();
            handleNavClick('home');
          }}
        >
          <BrandMark />
          <span className="ews-nav-wordmark">{content.meta.siteName}</span>
        </a>

        <nav className="ews-nav-links" aria-label="Main">
          {content.nav.items.map((item) => {
            const active = item.page === activePage;
            return (
              <a
                key={item.page}
                href={buildPath({ locale: content.locale, page: item.page })}
                className={active ? 'ews-nav-link is-active' : 'ews-nav-link'}
                aria-current={active ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  handleNavClick(item.page);
                }}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="ews-nav-actions">
          <button
            type="button"
            className="ews-locale-pill"
            onClick={() => onSwitchLocale(nextLocale)}
            aria-label={`Switch language to ${content.common.switchLocaleLabel}`}
          >
            <SiteIcon name="globe" />
            <span>{content.common.switchLocaleLabel}</span>
          </button>

          <a
            className="ews-nav-ghost ews-hide-sm"
            href={buildPath({ locale: content.locale, page: 'enterprise' })}
            onClick={(e) => {
              e.preventDefault();
              handleNavClick('enterprise', undefined, 'booking');
            }}
          >
            {content.nav.bookDemo}
          </a>

          <a
            className="ews-nav-primary ews-hide-sm"
            href={buildPath({ locale: content.locale, page: 'download' })}
            onClick={(e) => {
              e.preventDefault();
              handleNavClick('download');
            }}
          >
            <SiteIcon name="download" />
            <span>{content.nav.downloadForOs[platform]}</span>
          </a>

          <button
            type="button"
            className="ews-nav-menu-btn"
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? content.common.menuClose : content.common.menuOpen}
            onClick={() => setMobileOpen((prev) => !prev)}
          >
            <SiteIcon name={mobileOpen ? 'close' : 'menu'} />
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="ews-mobile-drawer">
          <div className="ews-mobile-drawer-links">
            {content.nav.items.map((item) => {
              const active = item.page === activePage;
              return (
                <a
                  key={item.page}
                  href={buildPath({ locale: content.locale, page: item.page })}
                  className={active ? 'ews-mobile-link is-active' : 'ews-mobile-link'}
                  onClick={(e) => {
                    e.preventDefault();
                    handleNavClick(item.page);
                  }}
                >
                  {item.label}
                </a>
              );
            })}
            <a
              className="ews-mobile-link"
              href={SITE_CONFIG.links.accountPortal}
              target="_blank"
              rel="noreferrer"
            >
              <span>{content.common.accountLogin}</span>
              <SiteIcon name="external" />
            </a>
          </div>
          <div className="ews-mobile-drawer-ctas">
            <a
              className="ews-btn ews-btn-secondary ews-btn-block"
              href={buildPath({ locale: content.locale, page: 'enterprise' })}
              onClick={(e) => {
                e.preventDefault();
                handleNavClick('enterprise', undefined, 'booking');
              }}
            >
              {content.nav.bookDemo}
            </a>
            <a
              className="ews-btn ews-btn-dark ews-btn-block"
              href={buildPath({ locale: content.locale, page: 'download' })}
              onClick={(e) => {
                e.preventDefault();
                handleNavClick('download');
              }}
            >
              <SiteIcon name="download" />
              <span>{content.nav.downloadForOs[platform]}</span>
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
