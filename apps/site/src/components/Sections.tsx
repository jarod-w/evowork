import { useState } from 'react';

import { buildPath, copyToClipboard } from '../router.js';
import type {
  ActionLink,
  Locale,
  PageId,
  PromptCardItem,
  SiteContent,
  StepItem,
  TabbedShowcaseItem,
  TrustTierItem,
} from '../types.js';
import { BrandMark, SiteIcon } from './icons.js';
import { TabbedVisualStage } from './InteractiveStage.js';

export type NavigateFn = (page: PageId, docSlug?: string, anchor?: string) => void;

/** B4: 左栏竖排可点 Tab（带激活进度条）+ 右栏 760px 视觉舞台。 */
export function SplitTabbedShowcase({
  id,
  title,
  subtitle,
  items,
  tint,
}: {
  readonly id?: string | undefined;
  readonly title: string;
  readonly subtitle: string;
  readonly items: readonly TabbedShowcaseItem[];
  readonly tint: 'mint' | 'slate';
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const current = items[activeIndex] ?? items[0];
  if (!current) return null;

  return (
    <section id={id} className="ews-section">
      <div className="ews-container">
        <div className="ews-section-head">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>

        <div className="ews-split-showcase">
          <div className="ews-split-tabs" role="tablist" aria-label={title}>
            {items.map((item, idx) => {
              const active = idx === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={active ? 'ews-split-tab is-active' : 'ews-split-tab'}
                  onClick={() => setActiveIndex(idx)}
                >
                  <div className="ews-split-tab-top">
                    <span className="ews-split-tab-icon">
                      <SiteIcon name={item.icon} />
                    </span>
                    <span className="ews-split-tab-label">{item.label}</span>
                    <span className="ews-split-tab-tag">{item.deliverableTag}</span>
                  </div>
                  <p className="ews-split-tab-desc">{item.description}</p>
                  <span className="ews-split-tab-bar" aria-hidden="true" />
                </button>
              );
            })}
          </div>

          <div className="ews-split-stage" role="tabpanel" aria-label={current.label}>
            <TabbedVisualStage item={current} tint={tint} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** B5: 本地优先与联网边界矩阵 + 权限档位条。 */
export function TrustBoundaryMatrix({
  id,
  title,
  subtitle,
  localTitle,
  localBadge,
  localItems,
  networkTitle,
  networkBadge,
  networkItems,
  tiersTitle,
  tiers,
  guardrails,
}: {
  readonly id?: string | undefined;
  readonly title: string;
  readonly subtitle: string;
  readonly localTitle: string;
  readonly localBadge: string;
  readonly localItems: readonly string[];
  readonly networkTitle: string;
  readonly networkBadge: string;
  readonly networkItems: readonly string[];
  readonly tiersTitle: string;
  readonly tiers: readonly TrustTierItem[];
  readonly guardrails: readonly string[];
}) {
  return (
    <section id={id} className="ews-section">
      <div className="ews-container">
        <div className="ews-section-head">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>

        <div className="ews-trust-grid">
          <div className="ews-trust-card is-local">
            <div className="ews-trust-card-head">
              <h3>{localTitle}</h3>
              <span className="ews-badge-accent">{localBadge}</span>
            </div>
            <ul className="ews-check-list">
              {localItems.map((item) => (
                <li key={item}>
                  <span className="ews-list-check">
                    <SiteIcon name="check" />
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="ews-trust-card">
            <div className="ews-trust-card-head">
              <h3>{networkTitle}</h3>
              <span className="ews-badge-neutral">{networkBadge}</span>
            </div>
            <ul className="ews-check-list">
              {networkItems.map((item) => (
                <li key={item}>
                  <span className="ews-list-check is-neutral">
                    <SiteIcon name="globe" />
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="ews-tiers-panel">
          <h3 className="ews-tiers-heading">{tiersTitle}</h3>
          <div className="ews-tiers-grid">
            {tiers.map((tier) => (
              <div key={tier.name} className={`ews-tier-card is-${tier.tone}`}>
                <div className="ews-tier-top">
                  <strong>{tier.name}</strong>
                  <span className={`ews-tier-badge is-${tier.tone}`}>{tier.badge}</span>
                </div>
                <p>{tier.description}</p>
              </div>
            ))}
          </div>

          <div className="ews-guardrail-strip">
            {guardrails.map((item) => (
              <div key={item} className="ews-guardrail-item">
                <SiteIcon name="shield" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** B6: 双行横向提示词场景卡（点击直接复制提示词，悬停自动减速/暂停）。 */
export function PromptMarquee({
  title,
  subtitle,
  clickHint,
  copiedLabel,
  rows,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly clickHint: string;
  readonly copiedLabel: string;
  readonly rows: readonly [readonly PromptCardItem[], readonly PromptCardItem[]];
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleCopy(card: PromptCardItem) {
    await copyToClipboard(card.prompt);
    setCopiedId(card.id);
    window.setTimeout(() => {
      setCopiedId((curr) => (curr === card.id ? null : curr));
    }, 1800);
  }

  return (
    <section className="ews-section">
      <div className="ews-container">
        <div className="ews-section-head">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>

      <div className="ews-marquee-wrap">
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className={rowIndex === 1 ? 'ews-marquee-row is-reverse' : 'ews-marquee-row'}
          >
            <div className="ews-marquee-track">
              {[...row, ...row].map((card, dupIndex) => {
                const isCopied = copiedId === card.id;
                const key = `${card.id}-${dupIndex}`;
                return (
                  <button
                    key={key}
                    type="button"
                    className={isCopied ? 'ews-prompt-card is-copied' : 'ews-prompt-card'}
                    onClick={() => {
                      void handleCopy(card);
                    }}
                    aria-label={`${card.title}: ${card.prompt}`}
                  >
                    <div className="ews-prompt-card-top">
                      <span className="ews-prompt-cat">{card.category}</span>
                      <span className="ews-prompt-format">{card.formatTag}</span>
                    </div>
                    <div className="ews-prompt-title">{card.title}</div>
                    <p className="ews-prompt-body">{card.prompt}</p>
                    <div className="ews-prompt-action">
                      <SiteIcon name={isCopied ? 'check' : 'copy'} />
                      <span>{isCopied ? copiedLabel : clickHint}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** B7: 编号步骤指南卡（下载上手与文档均复用）。 */
export function StepperGuideBlock({
  title,
  subtitle,
  steps,
  locale,
  onNavigate,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly steps: readonly StepItem[];
  readonly locale: Locale;
  readonly onNavigate: NavigateFn;
}) {
  return (
    <section className="ews-section">
      <div className="ews-container">
        <div className="ews-section-head">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>

        <div className="ews-stepper-grid">
          {steps.map((step) => (
            <div key={step.number} className="ews-step-card">
              <span className="ews-step-num">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
              {step.action && step.action.page && (
                <a
                  className="ews-inline-link"
                  href={buildPath({
                    locale,
                    page: step.action.page,
                    docSlug: step.action.docSlug,
                  })}
                  onClick={(e) => {
                    e.preventDefault();
                    if (step.action?.page) {
                      onNavigate(step.action.page, step.action.docSlug, step.action.anchor);
                    }
                  }}
                >
                  <span>{step.action.label}</span>
                  <SiteIcon name="arrow-right" />
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** B0: 居中收口行动区。 */
export function BookendCTA({
  title,
  subtitle,
  primaryAction,
  secondaryAction,
  locale,
  onNavigate,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly primaryAction: ActionLink;
  readonly secondaryAction?: ActionLink | undefined;
  readonly locale: Locale;
  readonly onNavigate: NavigateFn;
}) {
  return (
    <section className="ews-bookend">
      <div className="ews-container ews-bookend-inner">
        <h2>{title}</h2>
        <p>{subtitle}</p>
        <div className="ews-cta-row">
          {primaryAction.page && (
            <a
              className="ews-btn ews-btn-dark ews-btn-lg"
              href={buildPath({ locale, page: primaryAction.page, docSlug: primaryAction.docSlug })}
              onClick={(e) => {
                e.preventDefault();
                if (primaryAction.page) {
                  onNavigate(primaryAction.page, primaryAction.docSlug, primaryAction.anchor);
                }
              }}
            >
              <SiteIcon name="download" />
              <span>{primaryAction.label}</span>
            </a>
          )}
          {secondaryAction && secondaryAction.page && (
            <a
              className="ews-btn ews-btn-secondary ews-btn-lg"
              href={buildPath({
                locale,
                page: secondaryAction.page,
                docSlug: secondaryAction.docSlug,
              })}
              onClick={(e) => {
                e.preventDefault();
                if (secondaryAction.page) {
                  onNavigate(secondaryAction.page, secondaryAction.docSlug, secondaryAction.anchor);
                }
              }}
            >
              <span>{secondaryAction.label}</span>
              <SiteIcon name="arrow-right" />
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

/** B0: 极简单行页脚。 */
export function MinimalFooter({
  content,
  onNavigate,
}: {
  readonly content: SiteContent;
  readonly onNavigate: NavigateFn;
}) {
  return (
    <footer className="ews-footer">
      <div className="ews-container ews-footer-inner">
        <div className="ews-footer-left">
          <BrandMark className="ews-brand-mark-sm" />
          <span className="ews-footer-copy">{content.footer.copyright}</span>
          <span className="ews-footer-sep" aria-hidden="true">
            ·
          </span>
          <span className="ews-footer-note">{content.footer.licenseNote}</span>
        </div>

        <div className="ews-footer-links">
          {content.footer.links.map((link) => {
            if (link.external && link.href) {
              return (
                <a
                  key={link.label}
                  className="ews-footer-link"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>{link.label}</span>
                </a>
              );
            }
            if (link.page) {
              const targetPage = link.page;
              return (
                <a
                  key={link.label}
                  className="ews-footer-link"
                  href={buildPath({
                    locale: content.locale,
                    page: targetPage,
                    docSlug: link.docSlug,
                  })}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(targetPage, link.docSlug, link.anchor);
                  }}
                >
                  {link.label}
                </a>
              );
            }
            return null;
          })}
        </div>
      </div>
    </footer>
  );
}
