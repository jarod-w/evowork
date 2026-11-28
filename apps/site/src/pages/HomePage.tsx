import { useState } from 'react';

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
  const [activeSkillIdx, setActiveSkillIdx] = useState(0);
  const activeSkill = home.proSkillsSection.items[activeSkillIdx] ?? home.proSkillsSection.items[0];

  return (
    <>
      {/* Hero + 大尺寸交互演示舞台 */}
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

      {/* 板块 1：专业技能，让复杂工作更简单（金融·市场热点分析、学术·文献精读等） */}
      <section id="pro-skills" className="ews-section">
        <div className="ews-container">
          <div className="ews-section-head">
            <h2>{home.proSkillsSection.title}</h2>
            <p>{home.proSkillsSection.subtitle}</p>
          </div>

          <div className="ews-skills-showcase">
            <div
              className="ews-skills-rail"
              role="tablist"
              aria-label={home.proSkillsSection.title}
            >
              {home.proSkillsSection.items.map((skill, idx) => {
                const active = idx === activeSkillIdx;
                return (
                  <button
                    key={skill.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={active ? 'ews-skill-selector is-active' : 'ews-skill-selector'}
                    onClick={() => setActiveSkillIdx(idx)}
                  >
                    <div className="ews-skill-selector-top">
                      <span className="ews-skill-domain">{skill.domain}</span>
                      <span className="ews-skill-tag">{skill.deliverableTag}</span>
                    </div>
                    <div className="ews-skill-name">{skill.name}</div>
                    <p className="ews-skill-summary">{skill.summary}</p>
                  </button>
                );
              })}
            </div>

            {activeSkill && (
              <div
                className="ews-skill-stage"
                role="tabpanel"
                aria-label={`${activeSkill.domain} · ${activeSkill.name}`}
              >
                <div className="ews-skill-stage-card">
                  <div className="ews-tab-stage-head">
                    <div className="ews-tab-stage-title">
                      <span className="ews-tab-stage-icon">
                        <SiteIcon name="spark" />
                      </span>
                      <span>{activeSkill.outputTitle}</span>
                    </div>
                    <span className="ews-badge-accent">
                      {activeSkill.domain} · {activeSkill.name}
                    </span>
                  </div>

                  <div className="ews-tab-stage-prompt">
                    <span className="ews-tab-prompt-dot" aria-hidden="true" />
                    <p>{activeSkill.prompt}</p>
                  </div>

                  <div className="ews-wb-metrics">
                    {activeSkill.outputMetrics.map((metric) => (
                      <div key={metric.label} className="ews-wb-metric-card">
                        <span className="ews-wb-metric-label">{metric.label}</span>
                        <strong className="ews-wb-metric-value">{metric.value}</strong>
                      </div>
                    ))}
                  </div>

                  <ul className="ews-tab-stage-list">
                    {activeSkill.outputHighlights.map((line) => (
                      <li key={line}>
                        <span className="ews-list-check">
                          <SiteIcon name="check" />
                        </span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 板块 2：从复杂任务，到持续交付（Office 工具 / 深入调研分析 / 定时任务） */}
      <SplitTabbedShowcase
        id="delivery"
        title={home.deliverySection.title}
        subtitle={home.deliverySection.subtitle}
        items={home.deliverySection.items}
        tint="mint"
      />

      {/* 板块 3：操作电脑，完成复杂任务（本地文件读写 + 自动网页与跨页面操作） */}
      <section id="computer-action" className="ews-section">
        <div className="ews-container">
          <div className="ews-section-head">
            <h2>{home.computerActionSection.title}</h2>
            <p>{home.computerActionSection.subtitle}</p>
          </div>

          <div className="ews-computer-stage">
            <div className="ews-computer-banner">
              <span className="ews-badge-accent">{home.computerActionSection.badge}</span>
              <div className="ews-computer-prompt">
                <span className="ews-computer-prompt-label">
                  {home.computerActionSection.promptLabel}
                </span>
                <p>{home.computerActionSection.samplePrompt}</p>
              </div>
            </div>

            <div className="ews-computer-grid">
              {home.computerActionSection.capabilities.map((cap) => (
                <div key={cap.id} className="ews-computer-card">
                  <div className="ews-computer-card-head">
                    <span className="ews-tab-stage-icon">
                      <SiteIcon name={cap.icon} />
                    </span>
                    <span className="ews-badge-neutral">{cap.badge}</span>
                  </div>
                  <h3>{cap.title}</h3>
                  <p>{cap.description}</p>
                  <ul className="ews-check-list">
                    {cap.sampleSteps.map((step) => (
                      <li key={step}>
                        <span className="ews-list-check">
                          <SiteIcon name="check" />
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="ews-tab-stage-foot">
              <SiteIcon name="shield" />
              <span>{home.computerActionSection.footerNote}</span>
            </div>
          </div>
        </div>
      </section>

      {/* 板块 4：三步上手，接上你的模型就能用 */}
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

      {/* 板块 5：放心交给它 —— 本地隐私与审批边界 */}
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

      {/* 板块 6：双行横向提示词场景卡 */}
      <PromptMarquee
        title={home.promptSection.title}
        subtitle={home.promptSection.subtitle}
        clickHint={home.promptSection.clickHint}
        copiedLabel={content.common.copied}
        rows={home.promptSection.rows}
      />

      {/* 底部收口 CTA */}
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
