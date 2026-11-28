import { buildPath } from '../router.js';
import type { PlatformId, SiteContent } from '../types.js';
import { SiteIcon } from '../components/icons.js';
import { HeroWorkbenchStage } from '../components/InteractiveStage.js';
import {
  BookendCTA,
  type NavigateFn,
  PromptMarquee,
  SplitTabbedShowcase,
  TrustBoundaryMatrix,
} from '../components/Sections.js';

export function HomePage({
  content,
  platform,
  onNavigate,
}: {
  readonly content: SiteContent;
  readonly platform: PlatformId;
  readonly onNavigate: NavigateFn;
}) {
  const { home } = content;

  return (
    <>
      {/* B2: Hero + 大尺寸交互演示舞台 */}
      <section className="ews-hero">
        <div className="ews-container">
          <div className="ews-hero-center">
            <div className="ews-hero-eyebrow">
              <span className="ews-scene-dot" aria-hidden="true" />
              <span>{home.eyebrow}</span>
            </div>

            <h1 className="ews-hero-title">{home.headline}</h1>
            <p className="ews-hero-sub">{home.subheadline}</p>

            <div className="ews-cta-row">
              <a
                className="ews-btn ews-btn-dark ews-btn-lg"
                href={buildPath({ locale: content.locale, page: 'download' })}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate('download');
                }}
              >
                <SiteIcon name="download" />
                <span>{home.primaryCta[platform]}</span>
              </a>

              <a
                className="ews-btn ews-btn-secondary ews-btn-lg"
                href={buildPath({ locale: content.locale, page: 'docs', docSlug: 'quick-start' })}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate('docs', 'quick-start');
                }}
              >
                <span>{home.secondaryCta}</span>
                <SiteIcon name="arrow-right" />
              </a>
            </div>

            <div className="ews-trust-strip">
              {home.trustStrip.map((item) => (
                <span key={item} className="ews-trust-strip-item">
                  <SiteIcon name="check" />
                  <span>{item}</span>
                </span>
              ))}
            </div>
          </div>

          <HeroWorkbenchStage scenes={home.heroScenes} caption={home.stageCaption} />
        </div>
      </section>

      {/* B4: 办公成品三件套（Word / Excel / PPT） */}
      <SplitTabbedShowcase
        id="deliverables"
        title={home.deliverablesSection.title}
        subtitle={home.deliverablesSection.subtitle}
        items={home.deliverablesSection.items}
        tint="mint"
      />

      {/* B3: 零门槛上手（开箱即用 + BYOK） */}
      <section className="ews-section">
        <div className="ews-container">
          <div className="ews-section-head">
            <h2>{home.zeroBarrierSection.title}</h2>
            <p>{home.zeroBarrierSection.subtitle}</p>
          </div>

          <div className="ews-full-card">
            <div className="ews-mini-steps">
              {home.zeroBarrierSection.steps.map((step) => (
                <div key={step.num} className="ews-mini-step">
                  <span className="ews-mini-step-num">{step.num}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="ews-providers-panel">
              <div className="ews-providers-head">
                <strong>{home.zeroBarrierSection.providersLabel}</strong>
                <span className="ews-badge-accent">{home.zeroBarrierSection.badge}</span>
              </div>

              <div className="ews-provider-list">
                {home.zeroBarrierSection.providers.map((provider) => (
                  <div key={provider.name} className="ews-provider-tile">
                    <strong>{provider.name}</strong>
                    <span>{provider.note}</span>
                  </div>
                ))}
              </div>

              <a
                className="ews-inline-link"
                href={buildPath({ locale: content.locale, page: 'docs', docSlug: 'api-key-setup' })}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate('docs', 'api-key-setup');
                }}
              >
                <span>{home.zeroBarrierSection.guideLinkLabel}</span>
                <SiteIcon name="arrow-right" />
              </a>

              <p className="ews-provider-note">{home.zeroBarrierSection.noAccountNote}</p>
            </div>
          </div>
        </div>
      </section>

      {/* B4: 从单次任务到自动工作流 */}
      <SplitTabbedShowcase
        id="workflows"
        title={home.workflowSection.title}
        subtitle={home.workflowSection.subtitle}
        items={home.workflowSection.items}
        tint="slate"
      />

      {/* B5: 放心交给它 —— 本地隐私与审批边界 */}
      <TrustBoundaryMatrix
        id="trust"
        title={home.trustSection.title}
        subtitle={home.trustSection.subtitle}
        localTitle={home.trustSection.localTitle}
        localBadge={home.trustSection.localBadge}
        localItems={home.trustSection.localItems}
        networkTitle={home.trustSection.networkTitle}
        networkBadge={home.trustSection.networkBadge}
        networkItems={home.trustSection.networkItems}
        tiersTitle={home.trustSection.tiersTitle}
        tiers={home.trustSection.tiers}
        guardrails={home.trustSection.guardrails}
      />

      {/* B6: 双行横向提示词场景卡 */}
      <PromptMarquee
        title={home.promptSection.title}
        subtitle={home.promptSection.subtitle}
        clickHint={home.promptSection.clickHint}
        copiedLabel={content.common.copied}
        rows={home.promptSection.rows}
      />

      {/* B0: 底部收口 CTA */}
      <BookendCTA
        title={home.bottomCta.title}
        subtitle={home.bottomCta.subtitle}
        primaryAction={{ label: home.bottomCta.primaryLabel, page: 'download' }}
        secondaryAction={{
          label: home.bottomCta.secondaryLabel,
          page: 'enterprise',
          anchor: 'booking',
        }}
        locale={content.locale}
        onNavigate={onNavigate}
      />
    </>
  );
}
