import type { ReactNode } from 'react';

export type SiteIconName =
  | 'download'
  | 'arrow-right'
  | 'check'
  | 'copy'
  | 'doc'
  | 'table'
  | 'slides'
  | 'library'
  | 'clock'
  | 'target'
  | 'spark'
  | 'shield'
  | 'globe'
  | 'menu'
  | 'close'
  | 'external'
  | 'search'
  | 'chevron-down'
  | 'terminal'
  | 'mail';

const ICON_PATHS: Record<SiteIconName, ReactNode> = {
  download: <path d="M8 2.5v7.8M4.6 7.4 8 10.8l3.4-3.4M2.5 13.5h11" />,
  'arrow-right': <path d="M3 8h10M9 4l4 4-4 4" />,
  check: <path d="M3.2 8.4 6.5 11.6 13 4.8" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" />
    </>
  ),
  doc: (
    <>
      <path d="M4 2.2h5.2l3.3 3.3v8.3A1.2 1.2 0 0 1 11.3 15H4a1.2 1.2 0 0 1-1.2-1.2V3.4A1.2 1.2 0 0 1 4 2.2Z" />
      <path d="M9.2 2.2v3.3h3.3M5.3 8.2h5.4M5.3 10.8h4.2" />
    </>
  ),
  table: (
    <>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6" />
      <path d="M2.2 6.4h11.6M2.2 9.8h11.6M6.6 6.4v6.8" />
    </>
  ),
  slides: (
    <>
      <rect x="2" y="3" width="12" height="8.5" rx="1.6" />
      <path d="M8 11.5v2.5M5.5 14h5M5 6.4h6M5 8.8h3.8" />
    </>
  ),
  library: (
    <>
      <path d="M2.5 4.2A1.2 1.2 0 0 1 3.7 3h3l1.3 1.6h4.3a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2v-7.6Z" />
      <path d="M5.5 8.8h5" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8v3.5l2.4 1.4" />
    </>
  ),
  target: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <circle cx="8" cy="8" r="2.7" />
      <path d="M8 8h0.01" />
    </>
  ),
  spark: <path d="M8 2.2 9.5 6.3 13.8 8 9.5 9.7 8 13.8 6.5 9.7 2.2 8 6.5 6.3 8 2.2Z" />,
  shield: (
    <>
      <path d="M8 2.1 13.2 4v3.8c0 3.1-2.1 5.3-5.2 6.2-3.1-.9-5.2-3.1-5.2-6.2V4L8 2.1Z" />
      <path d="M5.7 8.1 7.3 9.7 10.6 6.3" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.4 8h11.2M8 2.2c1.6 1.6 2.4 3.6 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.2 5.6 8S6.4 3.8 8 2.2Z" />
    </>
  ),
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  external: (
    <path d="M6.5 3.5H3.8a1.3 1.3 0 0 0-1.3 1.3v7.4a1.3 1.3 0 0 0 1.3 1.3h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5M9.5 2.5h4v4M7.2 8.8l6.3-6.3" />
  ),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.5" />
      <path d="m10.7 10.7 3 3" />
    </>
  ),
  'chevron-down': <path d="m4.2 6.2 3.8 3.8 3.8-3.8" />,
  terminal: (
    <>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.6" />
      <path d="m4.8 6.4 2.2 1.8-2.2 1.8M8.3 10h2.8" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="3.2" width="12" height="9.6" rx="1.6" />
      <path d="m2.8 4.4 5.2 4 5.2-4" />
    </>
  ),
};

export function SiteIcon({
  name,
  className = 'ews-icon',
}: {
  readonly name: SiteIconName;
  readonly className?: string | undefined;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** EvoWork 品牌标记（与桌面端和 apps/web 共用 K5 品牌图形规范）。 */
export function BrandMark({
  className = 'ews-brand-mark',
}: {
  readonly className?: string | undefined;
}) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--accent)" />
      <path
        d="M10 11h12M10 16h8M10 21h12"
        stroke="var(--text-inverse)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
