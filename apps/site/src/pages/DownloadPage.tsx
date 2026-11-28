import { useState } from 'react';

import { SITE_CONFIG } from '../config.js';
import { copyToClipboard } from '../router.js';
import type { PlatformId, SiteContent } from '../types.js';
import { SiteIcon } from '../components/icons.js';
import { type NavigateFn, StepperGuideBlock } from '../components/Sections.js';

export function DownloadPage({
  content,
  platform,
  onNavigate,
  showMacUnsignedGuide = SITE_CONFIG.showMacUnsignedGuide,
}: {
  readonly content: SiteContent;
  readonly platform: PlatformId;
  readonly onNavigate: NavigateFn;
  /** 支持测试和运行期配置覆写，拿到 Apple 公证签名后置 false 即可全局隐藏。 */
  readonly showMacUnsignedGuide?: boolean | undefined;
}) {
  const { download } = content;
  const [copiedCmd, setCopiedCmd] = useState(false);

  async function handleCopyCommand() {
    await copyToClipboard(download.unsignedGuide.command);
    setCopiedCmd(true);
    window.setTimeout(() => setCopiedCmd(false), 1800);
  }

  return (
    <>
      <section className="ews-hero ews-hero-compact">
        <div className="ews-container">
          <div className="ews-hero-center">
            <div className="ews-hero-eyebrow">
              <span className="ews-scene-dot" aria-hidden="true" />
              <span>{download.eyebrow}</span>
            </div>
            <h1 className="ews-hero-title">{download.title}</h1>
            <p className="ews-hero-sub">{download.subtitle}</p>
          </div>

          <div className="ews-download-grid">
            {download.platforms.map((item) => {
              const recommended = item.id === platform;
              return (
                <div
                  key={item.id}
                  className={recommended ? 'ews-platform-card is-recommended' : 'ews-platform-card'}
                >
                  <div className="ews-platform-top">
                    <div>
                      <h2>{item.name}</h2>
                      <div className="ews-platform-arch">{item.arch}</div>
                    </div>
                    <span className={recommended ? 'ews-badge-accent' : 'ews-badge-neutral'}>
                      {recommended ? download.detectedLabel : item.badge}
                    </span>
                  </div>

                  <div className="ews-platform-meta">
                    <div>
                      <code>{item.fileName}</code>
                    </div>
                    <div>
                      {download.requirementsLabel}: {item.requirements}
                    </div>
                    <div>{item.sizeText}</div>
                    <div>
                      {download.checksumLabel}: {item.sha256Hint}
                    </div>
                  </div>

                  <ul className="ews-check-list">
                    {item.highlights.map((line) => (
                      <li key={line}>
                        <span className="ews-list-check">
                          <SiteIcon name="check" />
                        </span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>

                  <a
                    className={
                      recommended
                        ? 'ews-btn ews-btn-dark ews-btn-block'
                        : 'ews-btn ews-btn-secondary ews-btn-block'
                    }
                    href={item.url}
                  >
                    <SiteIcon name="download" />
                    <span>
                      {download.downloadButton} · {item.name}
                    </span>
                  </a>
                </div>
              );
            })}
          </div>

          {/* 可配置开关的 macOS 未签名 xattr 引导卡 */}
          {showMacUnsignedGuide && (
            <div className="ews-unsigned-card" data-testid="mac-unsigned-guide">
              <div>
                <span className="ews-badge-warn">
                  <SiteIcon name="terminal" />
                  <span>{download.unsignedGuide.badge}</span>
                </span>
                <h3>{download.unsignedGuide.title}</h3>
                <p>{download.unsignedGuide.subtitle}</p>
                <ol className="ews-unsigned-steps">
                  {download.unsignedGuide.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>

              <div className="ews-cmd-box">
                <div className="ews-cmd-head">
                  <span>Terminal</span>
                  <button
                    type="button"
                    className="ews-btn ews-btn-secondary ews-btn-sm"
                    onClick={() => {
                      void handleCopyCommand();
                    }}
                  >
                    <SiteIcon name={copiedCmd ? 'check' : 'copy'} />
                    <span>{copiedCmd ? content.common.copied : content.common.copyCommand}</span>
                  </button>
                </div>
                <pre className="ews-cmd-code">
                  <code>{download.unsignedGuide.command}</code>
                </pre>
                <div className="ews-platform-arch">{download.unsignedGuide.note}</div>
              </div>
            </div>
          )}

          <div className="ews-notice-banner">
            <strong>{download.windowsTip.badge}：</strong>
            {download.windowsTip.title} — {download.windowsTip.body}
          </div>

          <div className="ews-notice-banner">{download.unavailableNotice}</div>
        </div>
      </section>

      {/* B7: 3 步快速上手 */}
      <StepperGuideBlock
        title={download.quickStartTitle}
        subtitle={download.quickStartSubtitle}
        steps={download.quickStartSteps}
        locale={content.locale}
        onNavigate={onNavigate}
      />

      {/* 近期更新记录 */}
      <section className="ews-section">
        <div className="ews-container">
          <div className="ews-section-head">
            <h2>{download.changelogTitle}</h2>
            <p>{download.changelogSubtitle}</p>
          </div>

          <div className="ews-changelog-grid">
            {download.changelogReleases.map((rel) => (
              <article key={rel.version} className="ews-release-card">
                <div className="ews-release-head">
                  <span className="ews-release-ver">v{rel.version}</span>
                  <span className="ews-badge-accent">{rel.label}</span>
                </div>
                <ul className="ews-release-list">
                  {rel.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className="ews-notice-banner">
            <a
              className="ews-inline-link"
              href={SITE_CONFIG.links.github}
              target="_blank"
              rel="noreferrer"
            >
              <span>{download.viewAllReleasesLabel}</span>
              <SiteIcon name="external" />
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
