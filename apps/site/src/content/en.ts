import { SITE_CONFIG } from '../config.js';
import type { SiteContent } from '../types.js';

export const EN_CONTENT: SiteContent = {
  locale: 'en',
  htmlLang: 'en',
  meta: {
    siteName: 'EvoWork',
    tagline: 'Describe the job in one sentence. Get back ready-to-use files.',
    pageTitles: {
      home: 'EvoWork — Describe the job in one sentence. Get back ready-to-use files.',
      download: 'Download — EvoWork',
      docs: 'Documentation — EvoWork',
      enterprise: 'Enterprise & Private Deployment — EvoWork',
    },
  },
  common: {
    copied: 'Copied',
    copyCommand: 'Copy command',
    copyPrompt: 'Copy prompt',
    switchLocaleLabel: '中文',
    menuOpen: 'Open navigation menu',
    menuClose: 'Close navigation menu',
    backToTop: 'Back to top',
  },
  nav: {
    items: [
      { page: 'home', label: 'Home' },
      { page: 'download', label: 'Download' },
      { page: 'docs', label: 'Docs' },
      { page: 'enterprise', label: 'Enterprise' },
    ],
    bookDemo: 'Book a Demo',
    downloadForOs: {
      macos: 'Download for macOS',
      windows: 'Download for Windows',
    },
    downloadGeneric: 'Download',
  },
  home: {
    eyebrow: 'EvoWork · Desktop AI Work Assistant',
    headline: 'Describe the job in one sentence. Get back ready-to-use files.',
    subheadline:
      'Hand weekly reports, contracts, spreadsheets, market research, and quarterly decks to an AI assistant on your computer. It plans, reads your local files, checks its own work, and hands back polished Word, Excel, and PowerPoint files.',
    primaryCta: {
      macos: 'Download Free for macOS',
      windows: 'Download Free for Windows',
    },
    secondaryCta: '3-Minute Quick Start',
    trustStrip: [
      'Files processed locally',
      'No EvoWork account required',
      'Ready for Word, Excel & PowerPoint',
      'Asks before sensitive actions',
    ],
    stageCaption:
      'Interactive preview: switch scenarios above to see EvoWork deliver finished office files',
    heroScenes: [
      {
        id: 'sales-report',
        tabLabel: 'Sales Rollup + Quarterly Deck',
        taskTitle: 'Consolidate October regional sales & build Q4 deck',
        prompt:
          'Combine the 3 regional October sales spreadsheets in this folder, verify MoM growth and target attainment, and deliver a reconciled Excel workbook plus an 8-slide review deck.',
        modeTag: 'Ask to Approve',
        modelTag: 'DeepSeek / Kimi / GLM',
        steps: [
          { text: 'Read 3 local .xlsx ledgers (240 rows) and mapped columns', status: 'done' },
          {
            text: 'Verified live Excel summary formulas against source line items',
            status: 'done',
          },
          {
            text: 'Exported editable 8-slide PPTX with crisp charts and reconciled workbook',
            status: 'done',
          },
        ],
        deliverableName: 'Oct_Sales_Rollup.xlsx + Q4_Review.pptx',
        deliverableKind: 'xlsx',
        deliverableBadge: 'Ready to open',
        previewHeading: 'October 2026 Regional Sales Attainment',
        previewSubheading: 'Live formulas verified · Embedded charts · Ready to share',
        previewMetrics: [
          { label: 'Total Revenue', value: '$1.82M' },
          { label: 'Target Attainment', value: '108.4%' },
          { label: 'MoM Growth', value: '+14.2%' },
        ],
        previewRows: [
          { col1: 'East Region', col2: '$795K', col3: '112.4% attained', tone: 'good' },
          { col1: 'South Region', col2: '$592K', col3: '106.1% attained', tone: 'good' },
          { col1: 'North Region', col2: '$433K', col3: '101.8% attained', tone: 'neutral' },
        ],
      },
      {
        id: 'contract-audit',
        tabLabel: 'Scanned Contract → Risk Table',
        taskTitle: 'Review scanned annual supplier agreement (PDF)',
        prompt:
          'Review this 26-page scanned vendor contract and compile payment terms, liability caps, and auto-renewal risks into a structured Word review table with page numbers.',
        modeTag: 'Ask to Approve',
        modelTag: 'Local Text Scan + Review',
        steps: [
          { text: 'Scanned 26 PDF pages locally — raw file never left disk', status: 'done' },
          { text: 'Flagged 4 commercial risk clauses against review checklist', status: 'done' },
          {
            text: 'Generated formatted A4 Word review sheet with exact page citations',
            status: 'done',
          },
        ],
        deliverableName: 'Vendor_Agreement_Risk_Review.docx',
        deliverableKind: 'docx',
        deliverableBadge: 'A4 Doc · Citations included',
        previewHeading: 'Contract Risk Findings & Suggested Edits',
        previewSubheading: 'Local scan · Page-referenced clauses · Ready for legal sign-off',
        previewMetrics: [
          { label: 'Pages Scanned', value: '26' },
          { label: 'High Risk', value: '2 items' },
          { label: 'Redlines', value: '4 suggested' },
        ],
        previewRows: [
          {
            col1: 'p. 9 · Liability Cap',
            col2: 'No aggregate cap',
            col3: 'High · Cap at 20%',
            tone: 'warn',
          },
          {
            col1: 'p. 14 · Auto-Renewal',
            col2: '60-day notice window',
            col3: 'Medium · Shorten to 30d',
            tone: 'warn',
          },
          { col1: 'p. 19 · Acceptance', col2: '15 business days', col3: 'Standard', tone: 'good' },
        ],
      },
    ],
    proSkillsSection: {
      title: 'Specialized skills that make complex work simple',
      subtitle:
        'For each professional domain, EvoWork calls the right specialized skill, follows structured analysis workflows, and delivers results you can use immediately.',
      badge: 'Domain Skills',
      items: [
        {
          id: 'finance-hotspots',
          domain: 'Finance',
          name: 'Market Hotspot Analysis',
          summary:
            'Synthesize policy catalysts, earnings disclosures, and sector momentum into a structured brief with clear takeaways and risks.',
          deliverableTag: 'Market Brief · .docx',
          prompt:
            'Analyze key announcements and sector catalysts across energy storage and AI compute over the past two weeks, and deliver a structured Word brief with sources and risk notes.',
          outputTitle: 'Weekly_Market_Hotspots_Brief.docx',
          outputHighlights: [
            'Breaks down policy drivers, earnings signals, and sector themes with executive-first summaries',
            'Builds clean indicator comparison tables with cited public sources on every point',
            'Delivers a ready-to-share Word brief formatted for morning investment standups',
          ],
          outputMetrics: [
            { label: 'Coverage', value: 'Policy · Earnings · Flow' },
            { label: 'Citations', value: 'Source on every claim' },
            { label: 'Output', value: 'Word / PDF Brief' },
          ],
        },
        {
          id: 'academic-reading',
          domain: 'Academia',
          name: 'Deep Literature Reading',
          summary:
            'Read multiple PDF papers locally to extract research questions, methodology, key results, limitations, and citation lists.',
          deliverableTag: 'Lit Review · .docx',
          prompt:
            'Read the 8 research PDFs in this folder, compare their hypotheses, datasets, findings, and limitations in a table, and compile a formatted reference list.',
          outputTitle: 'Literature_Deep_Reading_Matrix.docx',
          outputHighlights: [
            'Extracts motivation, method design, benchmark numbers, and author-noted limitations per paper',
            'Produces a side-by-side comparison matrix to spot gaps and research opportunities quickly',
            'Compiles standardized bibliography entries ready for papers or lab meetings',
          ],
          outputMetrics: [
            { label: 'Batch Reading', value: 'Multi-PDF Matrix' },
            { label: 'Structure', value: 'Method · Result · Gap' },
            { label: 'References', value: 'Clean citation list' },
          ],
        },
        {
          id: 'legal-contract',
          domain: 'Legal & Ops',
          name: 'Contract Risk Review',
          summary:
            'Inspect scanned or digital agreements clause by clause, flagging payment, liability, and renewal risks with suggested edits.',
          deliverableTag: 'Review Table · .docx',
          prompt:
            'Review this annual supplier agreement against our risk checklist and output a Word table with severity tiers, page references, and suggested replacement wording.',
          outputTitle: 'Supplier_Agreement_Risk_Table.docx',
          outputHighlights: [
            'Reads scanned PDFs locally without uploading confidential contracts to third-party drives',
            'Categorizes High / Medium / Low risk clauses with ready-to-paste redline wording',
            'Preserves original clause numbers and page citations for fast legal verification',
          ],
          outputMetrics: [
            { label: 'Input Types', value: 'Word · PDF · Scans' },
            { label: 'Triage', value: 'High / Med / Low risk' },
            { label: 'Privacy', value: 'Originals stay local' },
          ],
        },
        {
          id: 'ops-analytics',
          domain: 'Business Ops',
          name: 'Financial & Ops Reporting',
          summary:
            'Consolidate spreadsheets across teams, reconcile totals with live formulas, flag anomalies, and generate clean visual charts.',
          deliverableTag: 'Workbook + Charts · .xlsx',
          prompt:
            'Merge 4 regional quarterly ledgers, calculate margin and YoY shifts by product line, highlight outliers, and add clean visual charts.',
          outputTitle: 'Quarterly_Ops_Variance_Workbook.xlsx',
          outputHighlights: [
            'Maps inconsistent column headers across departments and cross-checks every rollup',
            'Writes real editable Excel formulas so changing one number updates the whole sheet',
            'Produces crisp visual charts ready to paste straight into leadership updates',
          ],
          outputMetrics: [
            { label: 'Formulas', value: 'Live & editable' },
            { label: 'Anomalies', value: 'Auto-flagged shifts' },
            { label: 'Charts', value: 'Clean visuals' },
          ],
        },
      ],
    },
    deliverySection: {
      title: 'From complex tasks to continuous delivery',
      subtitle:
        'Research deeply, produce polished work deliverables, and put repetitive work on schedule.',
      items: [
        {
          id: 'office',
          icon: 'slides',
          label: 'Office Tools',
          description:
            'Create polished PowerPoint decks, Word documents, and Excel workbooks to accelerate professional delivery.',
          deliverableTag: 'PPT · Word · Excel',
          stageTitle: 'Deliver Editable Slides, Documents & Spreadsheets',
          stagePrompt:
            'Using these 3 monthly sales sheets and notes, create a reconciled Excel summary, a 10-slide leadership deck, and an executive Word brief.',
          stageHighlight: 'Native editable files · Clean formatting · Sharp readable charts',
          stageBullets: [
            'Word documents: crisp A4 layout, structured headings, and one-click PDF export',
            'Excel workbooks: live formulas cross-checked against raw line items',
            'PowerPoint decks: native editable shapes, tables, and charts with balanced spacing',
          ],
          stageFooterNote:
            'Ready to use out of the box—no copying walls of chat text into blank files',
        },
        {
          id: 'research',
          icon: 'library',
          label: 'Deep Research & Analysis',
          description:
            'Analyze complex topics deeply, gather information across multiple sources with citations, and produce comprehensive research reports.',
          deliverableTag: 'Deep Research · Report',
          stageTitle: 'Multi-Source Research Grounded in Citations',
          stagePrompt:
            'Conduct an in-depth study on workplace AI adoption, combining our local interview notes with public market data into a cited Word report.',
          stageHighlight:
            'Combines local files with live web lookups · Every reference clearly cited',
          stageBullets: [
            'Breaks complex questions into structured sub-topics across market, pricing, and competitor data',
            'Synthesizes your local PDFs and meeting notes alongside fresh public information',
            'Delivers an executive-first Word report with charts and a verifiable source list',
          ],
          stageFooterNote: 'Long research runs can be paused anytime and capped with a usage limit',
        },
        {
          id: 'schedule',
          icon: 'clock',
          label: 'Scheduled Tasks',
          description:
            'Run recurring analysis, weekly reports, and rollups automatically on your schedule.',
          deliverableTag: 'Auto Schedule',
          stageTitle: 'Every Monday 09:00 · Automated Team Report',
          stagePrompt:
            'Every Monday at 9 AM, review the latest updates in the Weekly Notes folder and generate a polished status report draft for my review.',
          stageHighlight:
            'Plain-language scheduling · Full run history · Auto-pauses after 3 errors',
          stageBullets: [
            'Supports daily, weekly, and monthly cadences plus optional active date windows',
            'Pause or resume any schedule in one click with complete output history',
            'Automatically pauses after 3 consecutive failures so tasks never burn usage silently',
          ],
          stageFooterNote: 'Runs locally inside the folders you explicitly authorize',
        },
      ],
    },
    computerActionSection: {
      title: 'Operate your computer to finish complex tasks',
      subtitle:
        'EvoWork can read, create, and edit local files on your computer—and automatically open web pages, fill out forms, and complete multi-page workflows.',
      badge: 'Local Files + Web Actions',
      promptLabel: 'Delegate cross-file, cross-page work in one sentence',
      samplePrompt:
        'Read all PDF invoices in the Desktop “Pending Expenses” folder, reconcile totals into an Excel ledger, and pre-fill the reimbursement web form—pause for my review before submitting.',
      capabilities: [
        {
          id: 'local-files',
          icon: 'library',
          badge: 'Local Files',
          title: 'Read, create, and batch-update local files',
          description:
            'Parse documents, organize folders, batch-rename files, convert formats, and write finished deliverables inside your chosen directories.',
          sampleSteps: [
            'Reads PDFs, Word, Excel, PowerPoint, zip archives, and scanned pages',
            'Batch-renames and organizes messy folders with an accompanying summary ledger',
            'Always asks with exact file paths before overwriting or deleting existing files',
          ],
        },
        {
          id: 'web-automation',
          icon: 'globe',
          badge: 'Web Automation',
          title: 'Open web pages, fill forms, and span multiple pages',
          description:
            'Navigate pages automatically to gather structured details, populate form fields from local files, and chain multi-step browser tasks.',
          sampleSteps: [
            'Opens multiple reference pages to gather and structure public information',
            'Fills out repetitive web form fields from your local spreadsheets cleanly',
            'Pauses automatically before sign-ins, final submissions, or sensitive steps',
          ],
        },
        {
          id: 'safe-handover',
          icon: 'shield',
          badge: 'Visible & Controllable',
          title: 'Every step visible—pause or take over anytime',
          description:
            'Track progress step by step inside authorized workspaces while keeping system directories and credentials protected.',
          sampleSteps: [
            'Defaults to “Ask to Approve” before touching files outside your workspace or going online',
            'Stop, redirect, or add new instructions at any point during execution',
            'Save any proven multi-step flow as a reusable skill for one-click reuse next time',
          ],
        },
      ],
      footerNote:
        'Cross-app desktop control is currently available as an experimental feature on macOS, with confirmation prompts before risky actions.',
    },
    zeroBarrierSection: {
      title: 'Up and running in 3 steps with your own model key',
      subtitle:
        'No complex setup. No EvoWork account required. Download, paste a model key, and ship your first file in three minutes.',
      badge: 'Easy Setup',
      steps: [
        {
          num: '01',
          title: 'Launch straight into the workspace',
          desc: 'Open the app and start right away—no sign-up walls or lengthy setup wizards.',
        },
        {
          num: '02',
          title: 'Add your preferred model key',
          desc: 'Connect DeepSeek, Kimi (Moonshot), GLM (Zhipu), or other compatible services anytime.',
        },
        {
          num: '03',
          title: 'Drop files and describe the goal',
          desc: 'Track progress and preview deliverables side by side, then open directly in your desktop apps.',
        },
      ],
      providersLabel: 'Works with leading model providers',
      providers: [
        { name: 'DeepSeek', note: 'V4 Pro / Flash · Step-by-step guide' },
        { name: 'Kimi (Moonshot)', note: 'K3.1 Pro · Great for long docs' },
        { name: 'GLM (Zhipu)', note: 'GLM 5.3 · Office-tested' },
        { name: 'Compatible Services', note: 'Custom endpoint support' },
      ],
      guideLinkLabel: 'Read the step-by-step model key guide',
      noAccountNote:
        'Your model keys stay encrypted in your OS keychain, masked to the last 4 digits, and never uploaded.',
    },
    trustSection: {
      title: 'Work you can trust: your files stay on your computer',
      subtitle: 'No fine print—these are the exact same privacy boundaries shown inside EvoWork.',
      localTitle: 'Stays on your computer',
      localBadge: 'Local-first · Raw files stay put',
      localItems: [
        'PDF, Word, Excel, PowerPoint, archive parsing, and scanned page reading run locally',
        'File edits, organization, and scheduled tasks execute inside your authorized folders',
        'Model keys stay encrypted in your system keychain and show only the last four digits',
        'Sensitive system folders and credential directories stay protected at all times',
      ],
      networkTitle: 'When it connects online',
      networkBadge: 'Transparent & model-only',
      networkItems: [
        'Only your prompts and relevant context go to the model provider you choose, without storing originals',
        'Live web lookups cite every source URL so you can verify claims quickly',
        'Installing a new skill discloses its actions and external hosts before you approve',
        'Honest feedback over silent workarounds whenever a model or feature has a limitation',
      ],
      tiersTitle: 'You decide how far it can go',
      tiers: [
        {
          name: 'Ask to Approve (Default)',
          badge: 'Recommended',
          tone: 'accent',
          description:
            'Prompts for your confirmation before editing files outside the workspace or accessing the internet.',
        },
        {
          name: 'Full Access',
          badge: 'Current task only',
          tone: 'neutral',
          description:
            'Requires explicit confirmation to enable and scopes to one task. Even here, delete actions ask first.',
        },
        {
          name: 'Approve for Me',
          badge: 'Planned · Not yet enabled',
          tone: 'muted',
          description:
            'Automated risk review that only prompts on flagged actions. Currently disabled and clearly marked in-app.',
        },
      ],
      guardrails: [
        'Explicit confirmation with exact file paths before deleting or overwriting files',
        'When you deny an action, EvoWork will not try to work around your decision',
        'Every step remains expandable and reviewable before you share final deliverables',
      ],
    },
    promptSection: {
      title: 'Copy a prompt and try real office workflows',
      subtitle: 'Click any card to copy the prompt—paste it into EvoWork with your own files.',
      clickHint: 'Click to copy',
      rows: [
        [
          {
            id: 'p-finance',
            category: 'Finance',
            title: 'Market Hotspot Brief',
            formatTag: '.docx',
            prompt:
              'Summarize this week’s key sector policies and market catalysts with data comparisons and risk notes into an executive Word brief.',
          },
          {
            id: 'p-academic',
            category: 'Academia',
            title: 'Multi-Paper Literature Review',
            formatTag: '.docx',
            prompt:
              'Read the 5 research PDFs in this folder, compare their methods, findings, and limitations in a table, and compile a formatted reference list.',
          },
          {
            id: 'p-excel',
            category: 'Finance & Ops',
            title: 'Multi-Sheet Reconciliation',
            formatTag: '.xlsx',
            prompt:
              'Merge the 3 regional sales workbooks in this folder, write live Excel formulas to reconcile totals by product line, and add a trend chart.',
          },
          {
            id: 'p-ppt',
            category: 'Presentations',
            title: 'Quarterly Review Deck',
            formatTag: '.pptx',
            prompt:
              'Turn this Q3 summary memo into a 10-slide editable PowerPoint deck highlighting KPI shifts, project retros, and Q4 priorities.',
          },
          {
            id: 'p-contract',
            category: 'Legal & Ops',
            title: 'Scanned Contract Audit',
            formatTag: '.docx',
            prompt:
              'Scan this supplier agreement locally and compile payment terms, liability caps, and auto-renewal risks into a cited Word review table.',
          },
        ],
        [
          {
            id: 'p-research',
            category: 'Deep Research',
            title: 'Cited Market Comparison',
            formatTag: '.docx',
            prompt:
              'Research 5 leading workplace AI tools online, combine with our local notes, and compile a cited Word comparison report.',
          },
          {
            id: 'p-batch',
            category: 'Computer Actions',
            title: 'Batch Invoices & Web Pre-fill',
            formatTag: 'Files + Web',
            prompt:
              'Inspect the PDF invoices in this folder, propose a “Date_Vendor_Amount” rename plan and summary Excel ledger, then pause for my approval.',
          },
          {
            id: 'p-schedule',
            category: 'Scheduled Tasks',
            title: 'Friday Delivery Digest',
            formatTag: 'Schedule',
            prompt:
              'Create a recurring task: every Friday at 5 PM, summarize updates in the Project Log folder into a clean delivery digest.',
          },
          {
            id: 'p-minutes',
            category: 'Meetings',
            title: 'Meeting Minutes & Owners',
            formatTag: '.docx',
            prompt:
              'Clean up these raw meeting notes into structured minutes with separate tables for Decisions Made and Action Items (owner + due date).',
          },
          {
            id: 'p-email',
            category: 'Client Comms',
            title: 'Proposal Email & PDF Quote',
            formatTag: '.pdf',
            prompt:
              'Draft a crisp client follow-up email based on this pricing sheet and attach a clean one-page PDF quotation.',
          },
        ],
      ],
    },
    bottomCta: {
      title: 'Leave busywork and formatting to EvoWork',
      subtitle:
        'Download free for desktop—no account required. Plug in your model key and deliver finished work in minutes.',
      primaryLabel: 'Go to Downloads',
      secondaryLabel: 'Enterprise / Book a Demo',
    },
  },
  download: {
    eyebrow: 'EvoWork · Desktop App',
    title: 'Download EvoWork and ship your first file in 3 minutes',
    subtitle:
      'Ready to produce polished Word, Excel, and PowerPoint files right after installation—no account sign-up or extra setup needed.',
    detectedLabel: 'Recommended for your system',
    downloadButton: 'Download Now',
    requirementsLabel: 'Requirements',
    checksumLabel: 'Setup note',
    unavailableNotice:
      'Note: Installers are currently available for Apple Silicon Macs (M1–M4) and 64-bit Windows. Intel Mac and Linux builds are not available yet.',
    platforms: [
      {
        id: 'macos',
        name: 'macOS (Apple Silicon)',
        arch: 'Apple Silicon · DMG Installer',
        badge: 'Apple Silicon (M-Series)',
        fileName: 'EvoWork-mac-arm64.dmg',
        sizeText: '~295 MB (ready to use out of the box)',
        requirements: 'macOS 13 or later · Apple M1 / M2 / M3 / M4',
        url: SITE_CONFIG.links.macArm64Dmg,
        sha256Hint:
          'Unsigned preview build — see the one-line Terminal step below for first launch',
        highlights: [
          'Drag to Applications and launch—no extra office add-ins required',
          'Full local document parsing, scan reading, and desktop actions',
          'One-click update checks inside Settings with zero forced upgrades',
        ],
      },
      {
        id: 'windows',
        name: 'Windows (64-bit)',
        arch: '64-bit · Guided Installer',
        badge: 'Windows 10 / 11',
        fileName: 'EvoWork-win-x64-setup.exe',
        sizeText: 'Guided installer with custom directory & shortcuts',
        requirements: 'Windows 10 / 11 (64-bit)',
        url: SITE_CONFIG.links.windowsSetupExe,
        sha256Hint: 'Supports custom install folders, shortcuts, and silent in-app upgrades',
        highlights: [
          'Interactive setup wizard with custom install folder and shortcut choices',
          'Installed versions upgrade seamlessly in-app and relaunch automatically',
          'Ready to generate Word, Excel, and PowerPoint files immediately',
        ],
      },
    ],
    unsignedGuide: {
      badge: 'macOS First Launch Note (Temporary)',
      title: 'Seeing “EvoWork is damaged and can’t be opened” on macOS?',
      subtitle:
        'The installer is completely intact. Because current builds are awaiting Apple notarization, macOS blocks the first launch. Paste this single command in Terminal after dragging EvoWork into Applications (this step will be removed once notarized).',
      command: 'xattr -cr /Applications/EvoWork.app',
      note: 'Drag EvoWork into your Applications folder first, then paste and run this command in Terminal.',
      steps: [
        'Open the downloaded .dmg and drag EvoWork into Applications.',
        'Open Terminal, copy the command on the right, paste it, and press Return.',
        'Open EvoWork from Applications—you will go straight into the main workspace.',
      ],
    },
    windowsTip: {
      badge: 'Windows Setup Note',
      title: 'Click “More info → Run anyway” if Windows prompts',
      body: 'Use the installer wizard to pick your folder and shortcuts. Future updates can be installed silently from Settings → About & Updates.',
    },
    quickStartTitle: '3 steps to your first finished deliverable',
    quickStartSubtitle: 'No EvoWork sign-up, no complex setup, no extra office add-ins.',
    quickStartSteps: [
      {
        number: '01',
        title: 'Open EvoWork straight into the workspace',
        description:
          'Skip lengthy onboarding. Your task files stay neatly organized in a dedicated folder that you can change anytime under Settings → General.',
      },
      {
        number: '02',
        title: 'Add a model key in Settings → Models',
        description:
          'Paste a key from DeepSeek, Kimi (Moonshot), GLM (Zhipu), or another compatible provider. Keys stay encrypted in your OS keychain.',
        action: {
          label: 'Read the step-by-step model key guide',
          page: 'docs',
          docSlug: 'api-key-setup',
        },
      },
      {
        number: '03',
        title: 'Drop your files and describe the output',
        description:
          'Back on the home screen, drag in spreadsheets or PDFs and ask for the Word, Excel, or PowerPoint file you need. Inspect and open finished files right from the side pane.',
        action: {
          label: 'Explore office deliverable tips',
          page: 'docs',
          docSlug: 'office-deliverables',
        },
      },
    ],
  },
  docs: {
    title: 'Documentation',
    subtitle:
      'Plain-language guides for everyday workplace tasks—from plugging in a model key to understanding every privacy guardrail.',
    searchPlaceholder: 'Search guides (e.g. DeepSeek, PPT, schedule, privacy)…',
    emptySearch: 'No matching guides found. Try searching for “key”, “Word”, or “privacy”.',
    onThisPage: 'On this page',
    previousLabel: 'Previous',
    nextLabel: 'Next',
    groups: [
      { id: 'getting-started', label: 'Getting Started' },
      { id: 'office', label: 'Office Workflows' },
      { id: 'workflow', label: 'Pro Skills & Schedules' },
      { id: 'security', label: 'Security & Boundaries' },
    ],
    articles: [
      {
        slug: 'quick-start',
        groupId: 'getting-started',
        title: 'Install & First Task in 3 Minutes',
        summary:
          'Everything from downloading the desktop app to receiving your first polished Word, Excel, or PPT file.',
        readingTime: '3 min read',
        sections: [
          {
            id: 'install',
            heading: '1. Install the Desktop App',
            paragraphs: [
              'Download the installer for your operating system from the Download page. EvoWork works out of the box to deliver formatted Word, Excel, and PowerPoint files with zero extra environment setup.',
            ],
            bullets: [
              'macOS (Apple Silicon): Drag EvoWork into Applications. If prompted on first launch, follow the one-line step on the Download page.',
              'Windows (64-bit): Run the setup wizard, choose your directory and shortcuts, and launch.',
            ],
          },
          {
            id: 'first-launch',
            heading: '2. Straight into the Workspace',
            paragraphs: [
              'EvoWork opens straight to your workspace with no mandatory account sign-up and no blocking onboarding tour.',
              'Tasks started without a project folder are saved neatly in a dedicated default directory, changeable anytime under Settings → General.',
            ],
          },
          {
            id: 'first-task',
            heading: '3. Delegate Your First Office Task',
            paragraphs: [
              'Once you add a model key, drop in your source files (Excel, PDF, screenshots) and explain what you want the same way you would brief a colleague.',
            ],
            callout: {
              tone: 'tip',
              title: 'How to get great deliverables on the first try',
              body: 'Include four quick details: source files, target audience, desired file format, and key focus areas. Example: “Using these two October ledgers, create a 2-page Word brief for leadership highlighting channels down more than 10% MoM.”',
            },
          },
        ],
      },
      {
        slug: 'api-key-setup',
        groupId: 'getting-started',
        title: 'Connect a Model Key (DeepSeek / Kimi / GLM)',
        summary:
          'No EvoWork account needed—get a key from your preferred provider and paste it into Settings → Models.',
        readingTime: '4 min read',
        sections: [
          {
            id: 'why-byok',
            heading: 'Why Use Your Own Model Key?',
            paragraphs: [
              'Your prompts go straight to the model provider you choose and you pay only for what you use—no mandatory platform subscription. Keys stay encrypted inside your operating system keychain and display only their last four digits.',
            ],
          },
          {
            id: 'deepseek-steps',
            heading: 'Example: Set Up DeepSeek in 4 Steps',
            paragraphs: [
              'For everyday work that includes screenshots or scanned images, choose deepseek-flash. For heavy multi-step analysis or long reports, try deepseek-v4-pro.',
            ],
            bullets: [
              'Step 1: Open platform.deepseek.com in your browser and sign in.',
              'Step 2: Check your balance under Usage.',
              'Step 3: Go to API keys → Create API key, and copy it immediately—keys are shown in full only once.',
              'Step 4: Open EvoWork Settings → Models, choose DeepSeek, paste the key, and save.',
            ],
            code: 'Service URL: https://api.deepseek.com\nRecommended models: deepseek-flash (daily work & vision) / deepseek-v4-pro (deep writing)',
          },
          {
            id: 'other-models',
            heading: 'Kimi, GLM, and Other Compatible Services',
            paragraphs: [
              'EvoWork also supports Kimi (Moonshot), GLM (Zhipu), and other compatible model services. Save multiple keys in Settings → Models and switch whenever you need.',
            ],
            callout: {
              tone: 'warn',
              title: 'Keep your key private',
              body: 'Never share your key publicly or paste it into shared documents. If you suspect a leak, revoke it immediately in your provider console.',
            },
          },
        ],
      },
      {
        slug: 'office-deliverables',
        groupId: 'office',
        title: 'Office Tools: Word, Excel & PowerPoint Guide',
        summary:
          'How EvoWork produces clean layouts, verified Excel formulas, and editable slide decks.',
        readingTime: '4 min read',
        sections: [
          {
            id: 'word-pdf',
            heading: 'Word Documents & PDF Export',
            paragraphs: [
              'EvoWork generates Word files with clean A4 formatting and structured headings—ideal for weekly reports, memos, and research reports. Export to PDF or open directly in Word/WPS from the result panel.',
            ],
          },
          {
            id: 'excel-charts',
            heading: 'Excel Workbooks & Data Charts',
            paragraphs: [
              'When consolidating spreadsheets or reconciling budgets, EvoWork inspects headers, writes live editable Excel formulas, and cross-checks summary totals against raw rows alongside crisp charts.',
            ],
          },
          {
            id: 'ppt-slides',
            heading: 'Editable PowerPoint Decks',
            paragraphs: [
              'Share your target slide count, audience, and source notes. EvoWork builds native .pptx decks where every text box, table, and chart stays editable in PowerPoint or Keynote.',
            ],
            callout: {
              tone: 'info',
              title: 'Model choice matters for complex decks',
              body: 'Deliverable polish on 10+ slide decks or multi-sheet financial models depends on the reasoning capability of the model you choose. Pick a flagship model for complex layouts.',
            },
          },
        ],
      },
      {
        slug: 'library-and-ocr',
        groupId: 'office',
        title: 'Local Files, Screenshot Paste & Scan Reading',
        summary:
          'Read PDFs, Office files, archives, and scanned documents locally without uploading raw files to third-party drives.',
        readingTime: '3 min read',
        sections: [
          {
            id: 'supported-files',
            heading: 'Supported File Formats',
            paragraphs: [
              'Drag files into the composer, pick folders, or press ⌘V / Ctrl+V anywhere in the window to paste screenshots directly into your draft.',
            ],
            bullets: [
              'Documents & slides: PDF, Word (.docx), PowerPoint (.pptx), Markdown, TXT',
              'Spreadsheets & data: Excel (.xlsx), CSV, TSV',
              'Images & archives: JPG / PNG / GIF / BMP and ZIP / RAR archives',
            ],
          },
          {
            id: 'local-ocr',
            heading: 'On-Device Scan Reading & @ Citations',
            paragraphs: [
              'Scanned PDFs and contract photos are read locally on your computer so original files never leave disk. Add recurring folders to your Library, then type @ in the composer to reference specific files directly.',
            ],
          },
        ],
      },
      {
        slug: 'automations-and-goals',
        groupId: 'workflow',
        title: 'Specialized Skills, Deep Research & Schedules',
        summary:
          'Invoke domain skills, schedule recurring reports, and keep long research tasks under control.',
        readingTime: '4 min read',
        sections: [
          {
            id: 'pro-skills',
            heading: 'Use Specialized Skills for Finance, Academia & Ops',
            paragraphs: [
              'Type / at the start of your message to select specialized skills such as market hotspot analysis, deep literature reading, contract review, or weekly reports. You can also turn any winning session into a reusable custom skill.',
            ],
          },
          {
            id: 'automations',
            heading: 'Scheduled Tasks',
            paragraphs: [
              'Describe recurring work in plain language—such as “Every Monday at 9 AM, compile last week’s notes into a team report draft.” Set optional active date ranges, pause or resume anytime, and rely on automatic pausing after 3 consecutive failures.',
            ],
          },
          {
            id: 'goal-budget',
            heading: 'Keep Long Research Controlled with /goal',
            paragraphs: [
              'Start a message with /goal to define a multi-step objective with a usage cap. Pause and resume anytime; hitting the cap immediately stops active execution so spending stays predictable.',
            ],
            code: '/goal Complete deep research across 10 industry PDFs into one report and stop if budget is reached',
          },
        ],
      },
      {
        slug: 'security-and-boundaries',
        groupId: 'security',
        title: 'Security Model, Approval Tiers & Current Scope',
        summary:
          'Clear documentation of what stays local, how approvals work, and current platform boundaries.',
        readingTime: '3 min read',
        sections: [
          {
            id: 'privacy-statement',
            heading: 'Where Does Your Data Go?',
            paragraphs: [
              'Document parsing, scan reading, local file work, and scheduled tasks run locally on your machine—raw files are not uploaded for parsing.',
              'Model inference requires internet access: prompts and relevant context are sent to the model provider you select and are not retained.',
            ],
          },
          {
            id: 'approval-tiers',
            heading: 'Approval Tiers & Guardrails',
            paragraphs: [
              '“Ask to Approve” is the default tier—EvoWork asks before editing files outside your workspace or using the internet. “Full Access” requires confirmation and scopes only to the current task.',
            ],
            bullets: [
              'Deleting or overwriting existing files asks for confirmation with exact file paths—even under Full Access, delete actions prompt first.',
              'Sensitive system folders and credential directories remain protected across all tiers.',
              '“Approve for Me” (automated risk review) is not enabled yet and is clearly marked in the app.',
            ],
          },
          {
            id: 'honest-limits',
            heading: 'Current Platform Scope',
            paragraphs: ['Current version scope that we continue to expand:'],
            bullets: [
              'Installers cover Apple Silicon Macs and 64-bit Windows (no Intel Mac or Linux installers yet).',
              'macOS builds await formal notarization and require one Terminal step on first launch.',
              'Cross-app desktop control is currently experimental on macOS.',
            ],
          },
        ],
      },
    ],
  },
  enterprise: {
    eyebrow: 'EvoWork Enterprise · Local-First Governance',
    title: 'Bring controllable AI office work into your organization',
    subtitle:
      'Keep raw documents on employee machines while centralizing access, model quotas, security policies, and compliance audits—empowering teams without compromising security.',
    primaryCta: 'Book a Demo & Consultation',
    secondaryCta: 'Explore Core Security Capabilities',
    modesTitle: 'Choose the deployment model that fits your security posture',
    modesSubtitle:
      'Unified desktop experience and enterprise governance—without forcing sensitive files onto a public cloud.',
    modes: [
      {
        id: 'cloud',
        badge: 'Fastest Start',
        title: 'Managed Cloud Organization',
        summary:
          'Turnkey organization accounts, shared model routing, and per-member quota controls—roll out to teams in a day.',
        points: [
          'Admins configure approved models and usage quotas centrally so staff never manage keys',
          'Document parsing and local task work remain on each employee’s computer',
          'Member invitations, usage alerts, and instant device revocation out of the box',
        ],
      },
      {
        id: 'private',
        badge: 'Most Popular',
        title: 'Private On-Prem / VPC Deployment',
        summary:
          'Host identity, enterprise model routing, policy distribution, and audit services inside your own network.',
        points: [
          'Full egress control—connect to internal LLMs or approved external model services',
          'Distribute centralized policies controlling allowed models, features, and guardrails',
          'Revoke device sessions centrally upon offboarding or lost hardware',
        ],
      },
      {
        id: 'airgapped',
        badge: 'Dedicated Delivery',
        title: 'Fully Air-Gapped Deployment',
        summary:
          'Built for regulated environments where installers, curated skills, and inference models stay 100% offline.',
        points: [
          'All external network dependencies disabled with zero silent fallback to the public internet',
          'Internal distribution of desktop packages and organization-vetted skill catalogs',
          'Joint acceptance testing tailored to your internal network environment',
        ],
      },
    ],
    nextPlanTitle: 'Core Enterprise Security & Audit Capabilities',
    nextPlanSubtitle:
      'Built for strict compliance and zero-leakage requirements across finance, legal, and large organizations:',
    nextPlanCards: [
      {
        id: 'audit-logs',
        badge: 'Core Capability · 01',
        title: 'Comprehensive Logging & Enterprise Audit',
        summary:
          'Capture and retain complete operational logs—covering task launches, file access, web and tool actions, approval decisions, and policy changes—for enterprise compliance audits and traceability.',
        flowSteps: [
          'Records complete employee and admin action trails searchable by team, user, and date',
          'Supports centralized archiving, tamper-evident retention, and one-click audit exports',
          'Captures blocked high-risk actions and approvals for rapid security reviews',
        ],
        highlight: 'Every AI-assisted deliverable becomes traceable and audit-ready',
      },
      {
        id: 'sensitive-masking',
        badge: 'Core Capability · 02',
        title: 'Sensitive Data Detection & Synthetic Masking',
        summary:
          'Automatically detect sensitive information—names, financials, contract entities, IDs, and accounts—and replace it with realistic synthetic data before sending anything to the LLM, then restore the real values locally when results return.',
        flowSteps: [
          'Detects built-in and enterprise-defined sensitive fields locally across docs and tables',
          'Replaces real values with consistent synthetic placeholders so LLMs never see real sensitive data',
          'Automatically restores the authentic values on-device once the model returns results',
        ],
        highlight:
          'Zero real sensitive data sent to LLMs—100% accurate real files returned to staff',
      },
    ],
    governanceTitle: 'Governance separated from content by design',
    governanceSubtitle:
      'Admins govern permissions, spend, and compliance while employee local documents remain on-device.',
    governanceCards: [
      {
        title: 'Admin console isolated from task content',
        description:
          'The enterprise console focuses on members, approved models, quotas, and security policies—without syncing local document contents into the admin panel.',
      },
      {
        title: 'Centralized policy rollout & diff preview',
        description:
          'Preview policy changes before rollout, track device adoption status, review revision history, or revoke immediately.',
      },
      {
        title: 'Device revocation & audit export',
        description:
          'View active devices per member, revoke one or all devices in one click, and export identity and admin audit reports.',
      },
    ],
    statusTitle: 'Enterprise Capabilities Overview',
    statusSubtitle:
      'End-to-end governance covering full audit logging, synthetic data masking, access control, and curated skill distribution.',
    statusColumns: ['Capability', 'Availability', 'Details'],
    statusRows: [
      {
        capability: 'Comprehensive activity logging & enterprise audit retention',
        status: 'ready',
        statusLabel: 'Included',
        detail:
          'Retains complete operational logs for enterprise compliance audits and traceability.',
      },
      {
        capability: 'Sensitive info detection & synthetic masking/restoration',
        status: 'ready',
        statusLabel: 'Included',
        detail:
          'Replaces sensitive fields with synthetic values before LLM calls and restores real data locally on return.',
      },
      {
        capability: 'Organization accounts, email verification & secure session renewal',
        status: 'ready',
        statusLabel: 'Included',
        detail:
          'Encrypted authentication, OS keychain protection, and seamless background refresh.',
      },
      {
        capability:
          'Tenant Admin Console (invites, quotas, default models, policies, audit export)',
        status: 'ready',
        statusLabel: 'Included',
        detail: 'Dedicated management console focused on access and spend governance.',
      },
      {
        capability: 'Curated skill distribution & offline office delivery',
        status: 'ready',
        statusLabel: 'Included',
        detail: 'Verified internal skill catalogs and offline-capable desktop office workflows.',
      },
      {
        capability: 'Enterprise SSO & directory integration',
        status: 'ready',
        statusLabel: 'Supported',
        detail: 'Integrates with your organization’s identity provider and group structures.',
      },
    ],
    booking: {
      title: 'Book a Demo or Discuss Private Deployment',
      subtitle:
        'Tell us about your team and workflows—we will get back within 1–2 business days to schedule a live walkthrough.',
      expectationsTitle: 'What you will get from the session',
      expectations: [
        'A live desktop demo tailored to your team’s real files (finance, legal, ops, or research)',
        'Deep dive into synthetic data masking, full audit logging, and private deployment sizing',
        'Guidance for piloting the tenant admin console and unified model routing',
      ],
      directEmailLabel: 'Prefer email? Reach us directly at',
      form: {
        nameLabel: 'Your name',
        namePlaceholder: 'e.g. Alex Chen',
        emailLabel: 'Work email',
        emailPlaceholder: 'alex@company.com',
        companyLabel: 'Company or team',
        companyPlaceholder: 'e.g. Acme Operations',
        teamSizeLabel: 'Estimated team size',
        teamSizeOptions: ['Under 10', '10 – 50', '50 – 200', '200+'],
        interestsLabel: 'What are you most interested in?',
        interestOptions: [
          'Team trial & central model quotas',
          'Private / on-prem deployment',
          'Sensitive data masking & full audit logs',
          'Internal LLM & domain skills integration',
        ],
        notesLabel: 'Workflow notes (optional)',
        notesPlaceholder:
          'e.g. Our finance and legal teams need local contract review with synthetic masking and full audit logging…',
        consentText:
          'I agree that the EvoWork team may use these details to respond to my inquiry.',
        submitLabel: 'Request a Demo',
        submittingLabel: 'Submitting…',
        previewModeNote:
          'Submit to confirm your request details or reach our enterprise team directly via email below.',
        validationName: 'Please enter your name',
        validationEmail: 'Please enter a valid work email address',
        validationCompany: 'Please enter your company or team name',
        validationConsent: 'Please confirm permission for us to contact you',
        successTitle: 'Request received',
        successBody:
          'Thanks for reaching out! We have received your demo request and will reply via email within 1–2 business days.',
        successPreviewBody:
          'Your request details are validated. Click the email button below to send your inquiry directly to our enterprise advisors.',
        successReset: 'Submit another inquiry',
        successDownloadCta: 'Try the free desktop app now',
        errorTitle: 'Could not submit right now',
        errorFallback:
          'Your entries are still saved above. Please retry shortly or email us directly at',
      },
    },
  },
  footer: {
    copyright: '© 2026 EvoWork',
    licenseNote: 'Local-first desktop AI work assistant',
    links: [
      { label: 'Download', page: 'download' },
      { label: 'Docs', page: 'docs', docSlug: 'quick-start' },
      { label: 'Security', page: 'docs', docSlug: 'security-and-boundaries' },
      { label: 'Enterprise', page: 'enterprise' },
    ],
  },
};
