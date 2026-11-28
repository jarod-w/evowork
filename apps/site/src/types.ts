export type Locale = 'zh' | 'en';

export type PageId = 'home' | 'download' | 'docs' | 'enterprise';

export type PlatformId = 'macos' | 'windows';

export interface RouteState {
  readonly locale: Locale;
  readonly page: PageId;
  readonly docSlug?: string | undefined;
}

export interface StageMediaOverride {
  readonly kind: 'video' | 'image';
  readonly src: string;
  readonly alt: string;
  readonly poster?: string | undefined;
}

export type HeroSceneId = 'sales-report' | 'contract-audit';

export type DeliverableSceneId = 'word' | 'excel' | 'ppt';

export type WorkflowSceneId = 'library' | 'schedule' | 'goal' | 'skill';

export type StageSceneId = HeroSceneId | DeliverableSceneId | WorkflowSceneId;

export interface ActionLink {
  readonly label: string;
  readonly page?: PageId | undefined;
  readonly docSlug?: string | undefined;
  readonly href?: string | undefined;
  readonly anchor?: string | undefined;
  readonly external?: boolean | undefined;
}

export interface HeroSceneSpec {
  readonly id: HeroSceneId;
  readonly tabLabel: string;
  readonly taskTitle: string;
  readonly prompt: string;
  readonly modeTag: string;
  readonly modelTag: string;
  readonly steps: readonly { readonly text: string; readonly status: 'done' | 'active' }[];
  readonly deliverableName: string;
  readonly deliverableKind: 'docx' | 'xlsx' | 'pptx';
  readonly deliverableBadge: string;
  readonly previewHeading: string;
  readonly previewSubheading: string;
  readonly previewMetrics: readonly { readonly label: string; readonly value: string }[];
  readonly previewRows: readonly {
    readonly col1: string;
    readonly col2: string;
    readonly col3: string;
    readonly tone?: 'neutral' | 'good' | 'warn' | undefined;
  }[];
  readonly mediaOverride?: StageMediaOverride | undefined;
}

export interface TabbedShowcaseItem {
  readonly id: StageSceneId;
  readonly icon: 'doc' | 'table' | 'slides' | 'library' | 'clock' | 'target' | 'spark';
  readonly label: string;
  readonly description: string;
  readonly deliverableTag: string;
  readonly stageTitle: string;
  readonly stagePrompt: string;
  readonly stageHighlight: string;
  readonly stageBullets: readonly string[];
  readonly stageFooterNote: string;
  readonly mediaOverride?: StageMediaOverride | undefined;
}

export interface PromptCardItem {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly formatTag: string;
  readonly prompt: string;
}

export interface TrustTierItem {
  readonly name: string;
  readonly badge: string;
  readonly tone: 'accent' | 'neutral' | 'muted';
  readonly description: string;
}

export interface StepItem {
  readonly number: string;
  readonly title: string;
  readonly description: string;
  readonly codeSnippet?: string | undefined;
  readonly tip?: string | undefined;
  readonly action?: ActionLink | undefined;
}

export interface PlatformDownloadSpec {
  readonly id: PlatformId;
  readonly name: string;
  readonly arch: string;
  readonly badge: string;
  readonly fileName: string;
  readonly sizeText: string;
  readonly requirements: string;
  readonly url: string;
  readonly sha256Hint: string;
  readonly highlights: readonly string[];
}

export interface DocCallout {
  readonly tone: 'info' | 'tip' | 'warn';
  readonly title: string;
  readonly body: string;
}

export interface DocSection {
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[] | undefined;
  readonly code?: string | undefined;
  readonly callout?: DocCallout | undefined;
}

export interface DocArticle {
  readonly slug: string;
  readonly groupId: string;
  readonly title: string;
  readonly summary: string;
  readonly readingTime: string;
  readonly sections: readonly DocSection[];
}

export interface DocGroup {
  readonly id: string;
  readonly label: string;
  readonly collapsible?: boolean | undefined;
  readonly defaultCollapsed?: boolean | undefined;
}

export interface EnterpriseModeCard {
  readonly id: string;
  readonly badge: string;
  readonly title: string;
  readonly summary: string;
  readonly points: readonly string[];
}

export interface EnterpriseStatusRow {
  readonly capability: string;
  readonly status: 'ready' | 'planned';
  readonly statusLabel: string;
  readonly detail: string;
}

export interface SiteContent {
  readonly locale: Locale;
  readonly htmlLang: string;
  readonly meta: {
    readonly siteName: string;
    readonly tagline: string;
    readonly pageTitles: Record<PageId, string>;
  };
  readonly common: {
    readonly copied: string;
    readonly copyCommand: string;
    readonly copyPrompt: string;
    readonly switchLocaleLabel: string;
    readonly menuOpen: string;
    readonly menuClose: string;
    readonly accountLogin: string;
    readonly backToTop: string;
    readonly openSourceBadge: string;
  };
  readonly nav: {
    readonly items: readonly { readonly page: PageId; readonly label: string }[];
    readonly bookDemo: string;
    readonly downloadForOs: Record<PlatformId, string>;
    readonly downloadGeneric: string;
  };
  readonly home: {
    readonly eyebrow: string;
    readonly headline: string;
    readonly subheadline: string;
    readonly primaryCta: Record<PlatformId, string>;
    readonly secondaryCta: string;
    readonly trustStrip: readonly string[];
    readonly stageCaption: string;
    readonly heroScenes: readonly HeroSceneSpec[];
    readonly deliverablesSection: {
      readonly title: string;
      readonly subtitle: string;
      readonly items: readonly TabbedShowcaseItem[];
    };
    readonly zeroBarrierSection: {
      readonly title: string;
      readonly subtitle: string;
      readonly badge: string;
      readonly steps: readonly {
        readonly num: string;
        readonly title: string;
        readonly desc: string;
      }[];
      readonly providersLabel: string;
      readonly providers: readonly { readonly name: string; readonly note: string }[];
      readonly guideLinkLabel: string;
      readonly noAccountNote: string;
    };
    readonly workflowSection: {
      readonly title: string;
      readonly subtitle: string;
      readonly items: readonly TabbedShowcaseItem[];
    };
    readonly trustSection: {
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
    };
    readonly promptSection: {
      readonly title: string;
      readonly subtitle: string;
      readonly clickHint: string;
      readonly rows: readonly [readonly PromptCardItem[], readonly PromptCardItem[]];
    };
    readonly bottomCta: {
      readonly title: string;
      readonly subtitle: string;
      readonly primaryLabel: string;
      readonly secondaryLabel: string;
    };
  };
  readonly download: {
    readonly eyebrow: string;
    readonly title: string;
    readonly subtitle: string;
    readonly detectedLabel: string;
    readonly downloadButton: string;
    readonly requirementsLabel: string;
    readonly checksumLabel: string;
    readonly unavailableNotice: string;
    readonly platforms: readonly PlatformDownloadSpec[];
    readonly unsignedGuide: {
      readonly badge: string;
      readonly title: string;
      readonly subtitle: string;
      readonly command: string;
      readonly note: string;
      readonly steps: readonly string[];
    };
    readonly windowsTip: {
      readonly badge: string;
      readonly title: string;
      readonly body: string;
    };
    readonly quickStartTitle: string;
    readonly quickStartSubtitle: string;
    readonly quickStartSteps: readonly StepItem[];
    readonly changelogTitle: string;
    readonly changelogSubtitle: string;
    readonly changelogReleases: readonly {
      readonly version: string;
      readonly label: string;
      readonly items: readonly string[];
    }[];
    readonly viewAllReleasesLabel: string;
  };
  readonly docs: {
    readonly title: string;
    readonly subtitle: string;
    readonly searchPlaceholder: string;
    readonly emptySearch: string;
    readonly onThisPage: string;
    readonly previousLabel: string;
    readonly nextLabel: string;
    readonly groups: readonly DocGroup[];
    readonly articles: readonly DocArticle[];
  };
  readonly enterprise: {
    readonly eyebrow: string;
    readonly title: string;
    readonly subtitle: string;
    readonly primaryCta: string;
    readonly secondaryCta: string;
    readonly modesTitle: string;
    readonly modesSubtitle: string;
    readonly modes: readonly EnterpriseModeCard[];
    readonly governanceTitle: string;
    readonly governanceSubtitle: string;
    readonly governanceCards: readonly { readonly title: string; readonly description: string }[];
    readonly statusTitle: string;
    readonly statusSubtitle: string;
    readonly statusColumns: readonly [string, string, string];
    readonly statusRows: readonly EnterpriseStatusRow[];
    readonly booking: {
      readonly title: string;
      readonly subtitle: string;
      readonly expectationsTitle: string;
      readonly expectations: readonly string[];
      readonly directEmailLabel: string;
      readonly form: {
        readonly nameLabel: string;
        readonly namePlaceholder: string;
        readonly emailLabel: string;
        readonly emailPlaceholder: string;
        readonly companyLabel: string;
        readonly companyPlaceholder: string;
        readonly teamSizeLabel: string;
        readonly teamSizeOptions: readonly string[];
        readonly interestsLabel: string;
        readonly interestOptions: readonly string[];
        readonly notesLabel: string;
        readonly notesPlaceholder: string;
        readonly consentText: string;
        readonly submitLabel: string;
        readonly submittingLabel: string;
        readonly previewModeNote: string;
        readonly validationName: string;
        readonly validationEmail: string;
        readonly validationCompany: string;
        readonly validationConsent: string;
        readonly successTitle: string;
        readonly successBody: string;
        readonly successPreviewBody: string;
        readonly successReset: string;
        readonly successDownloadCta: string;
        readonly errorTitle: string;
        readonly errorFallback: string;
      };
    };
  };
  readonly footer: {
    readonly copyright: string;
    readonly licenseNote: string;
    readonly links: readonly ActionLink[];
  };
}
