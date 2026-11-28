import { useState } from 'react';

import type { HeroSceneSpec, StageMediaOverride, TabbedShowcaseItem } from '../types.js';
import { BrandMark, SiteIcon } from './icons.js';

function MediaOverrideView({ media }: { readonly media: StageMediaOverride }) {
  if (media.kind === 'video') {
    return (
      <video
        className="ews-stage-media"
        src={media.src}
        poster={media.poster}
        autoPlay
        loop
        muted
        playsInline
        aria-label={media.alt}
      />
    );
  }
  return <img className="ews-stage-media" src={media.src} alt={media.alt} />;
}

/**
 * 首页 Hero 大尺寸交互桌面工作台模拟舞台。
 * 当配置传入 mediaOverride 时可无缝切换为真实录屏视频或截图。
 */
export function HeroWorkbenchStage({
  scenes,
  caption,
}: {
  readonly scenes: readonly HeroSceneSpec[];
  readonly caption: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const scene = scenes[activeIndex] ?? scenes[0];
  if (!scene) return null;

  return (
    <div className="ews-hero-stage-shell">
      <div className="ews-stage-scene-bar" role="tablist" aria-label={caption}>
        {scenes.map((item, idx) => {
          const active = idx === activeIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={active ? 'ews-scene-chip is-active' : 'ews-scene-chip'}
              onClick={() => setActiveIndex(idx)}
            >
              <span className="ews-scene-dot" aria-hidden="true" />
              <span>{item.tabLabel}</span>
            </button>
          );
        })}
      </div>

      {scene.mediaOverride ? (
        <div className="ews-stage-frame">
          <MediaOverrideView media={scene.mediaOverride} />
        </div>
      ) : (
        <div className="ews-stage-frame" role="tabpanel" aria-label={scene.taskTitle}>
          <div className="ews-window-chrome">
            <div className="ews-window-dots" aria-hidden="true">
              <span className="ews-win-dot" />
              <span className="ews-win-dot" />
              <span className="ews-win-dot" />
            </div>
            <div className="ews-window-title">
              <BrandMark className="ews-brand-mark-xs" />
              <span>EvoWork — {scene.taskTitle}</span>
            </div>
            <div className="ews-window-badges">
              <span className="ews-chip-soft">{scene.modeTag}</span>
              <span className="ews-chip-outline">{scene.modelTag}</span>
            </div>
          </div>

          <div className="ews-workbench-grid">
            {/* 左栏：对话与可追溯执行进度 */}
            <div className="ews-wb-chat">
              <div className="ews-wb-user-bubble">
                <p>{scene.prompt}</p>
              </div>

              <div className="ews-wb-steps">
                {scene.steps.map((step) => (
                  <div key={step.text} className="ews-wb-step-row">
                    <span className="ews-wb-step-icon">
                      <SiteIcon name="check" />
                    </span>
                    <span>{step.text}</span>
                  </div>
                ))}
              </div>

              <div className="ews-wb-composer-mock" aria-hidden="true">
                <span className="ews-wb-composer-placeholder">{scene.deliverableName}</span>
                <span className="ews-wb-composer-pill">{scene.modeTag}</span>
              </div>
            </div>

            {/* 右栏：成品办公文件直接预览 */}
            <div className="ews-wb-preview">
              <div className="ews-wb-preview-head">
                <div className="ews-wb-file-title">
                  <SiteIcon name={scene.deliverableKind === 'xlsx' ? 'table' : 'doc'} />
                  <span>{scene.deliverableName}</span>
                </div>
                <span className="ews-badge-accent">{scene.deliverableBadge}</span>
              </div>

              <div className="ews-wb-doc-sheet">
                <div className="ews-wb-doc-title">{scene.previewHeading}</div>
                <div className="ews-wb-doc-sub">{scene.previewSubheading}</div>

                <div className="ews-wb-metrics">
                  {scene.previewMetrics.map((m) => (
                    <div key={m.label} className="ews-wb-metric-card">
                      <span className="ews-wb-metric-label">{m.label}</span>
                      <strong className="ews-wb-metric-value">{m.value}</strong>
                    </div>
                  ))}
                </div>

                <div className="ews-wb-table">
                  {scene.previewRows.map((row) => (
                    <div key={row.col1} className="ews-wb-table-row">
                      <span className="ews-wb-cell-main">{row.col1}</span>
                      <span className="ews-wb-cell-mid">{row.col2}</span>
                      <span
                        className={
                          row.tone === 'warn'
                            ? 'ews-wb-cell-tag is-warn'
                            : row.tone === 'good'
                              ? 'ews-wb-cell-tag is-good'
                              : 'ews-wb-cell-tag'
                        }
                      >
                        {row.col3}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="ews-stage-caption">{caption}</p>
    </div>
  );
}

/**
 * B4 右侧视觉舞台组件（支持办公三件套与自动化/资料/预算/技能提炼场景）。
 */
export function TabbedVisualStage({
  item,
  tint,
}: {
  readonly item: TabbedShowcaseItem;
  readonly tint: 'mint' | 'slate';
}) {
  if (item.mediaOverride) {
    return (
      <div className={`ews-tab-stage is-${tint}`}>
        <MediaOverrideView media={item.mediaOverride} />
      </div>
    );
  }

  return (
    <div className={`ews-tab-stage is-${tint}`}>
      <div className="ews-tab-stage-card">
        <div className="ews-tab-stage-head">
          <div className="ews-tab-stage-title">
            <span className="ews-tab-stage-icon">
              <SiteIcon name={item.icon} />
            </span>
            <span>{item.stageTitle}</span>
          </div>
          <span className="ews-badge-accent">{item.deliverableTag}</span>
        </div>

        <div className="ews-tab-stage-prompt">
          <span className="ews-tab-prompt-dot" aria-hidden="true" />
          <p>{item.stagePrompt}</p>
        </div>

        <div className="ews-tab-stage-highlight">{item.stageHighlight}</div>

        <ul className="ews-tab-stage-list">
          {item.stageBullets.map((bullet) => (
            <li key={bullet}>
              <span className="ews-list-check">
                <SiteIcon name="check" />
              </span>
              <span>{bullet}</span>
            </li>
          ))}
        </ul>

        <div className="ews-tab-stage-foot">
          <SiteIcon name="shield" />
          <span>{item.stageFooterNote}</span>
        </div>
      </div>
    </div>
  );
}
