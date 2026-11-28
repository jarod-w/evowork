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
      download: 'Download & 3-Minute Setup — EvoWork',
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
    accountLogin: 'Sign in',
    backToTop: 'Back to top',
    openSourceBadge: `v${SITE_CONFIG.version} · MIT Open Source`,
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
    eyebrow: `EvoWork v${SITE_CONFIG.version} · Desktop AI Work Assistant`,
    headline: 'Describe the job in one sentence. Get back ready-to-use files.',
    subheadline:
      'Hand weekly reports, contracts, spreadsheets, and quarterly decks to an AI assistant on your computer. It plans, reads your local files, checks its own work, and hands back polished Word, Excel, and PowerPoint files.',
    primaryCta: {
      macos: 'Download Free for macOS',
      windows: 'Download Free for Windows',
    },
    secondaryCta: '3-Minute Quick Start',
    trustStrip: [
      'Files processed locally',
      'No EvoWork account required',
      'Built-in office runtime & CJK fonts',
      'MIT open source',
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
        modelTag: 'Local OCR + Model Review',
        steps: [
          {
            text: 'Ran local OCR on 26 scanned PDF pages — raw file never left disk',
            status: 'done',
          },
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
        previewSubheading: 'Local OCR · Page-referenced clauses · Ready for legal sign-off',
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
    deliverablesSection: {
      title: 'Finished office files you can send right away',
      subtitle:
        'Stop copying walls of chat text into blank documents. EvoWork bundles its own office runtime and fonts so clean Word, Excel, and PowerPoint files work out of the box.',
      items: [
        {
          id: 'word',
          icon: 'doc',
          label: 'Word Docs & Reports',
          description:
            'Weekly updates, proposals, meeting notes, and contract reviews in crisp A4 layout with one-click PDF export.',
          deliverableTag: '.docx / .pdf',
          stageTitle: 'Quarterly_Competitor_Brief.docx',
          stagePrompt:
            'Turn these 5 interview notes and briefs into a formal Word report with an executive summary, comparison matrix, and action items.',
          stageHighlight: 'A4 default · Clean headings & tables · Reliable PDF export',
          stageBullets: [
            'Produces structured executive summaries, tables, and hierarchy without manual reformatting',
            'Lists web source links automatically whenever live research is referenced',
            'Open directly in Microsoft Word, WPS, or export to PDF straight from the result pane',
          ],
          stageFooterNote: 'Built-in layout & pagination checks prevent silent content truncation',
        },
        {
          id: 'excel',
          icon: 'table',
          label: 'Excel Workbooks & Charts',
          description:
            'Clean data, build summary sheets with live formulas, cross-check totals against raw rows, and render clean charts.',
          deliverableTag: '.xlsx / .png',
          stageTitle: 'Q3_Budget_Variance_Rollup.xlsx',
          stagePrompt:
            'Merge 3 department expense sheets, calculate YoY variance by category with live formulas, and add a chart sheet.',
          stageHighlight: 'Live editable formulas · Reconciled totals · Zero broken chart fonts',
          stageBullets: [
            'Writes real SUM / SUMIFS formulas instead of hardcoded static numbers',
            'Maps messy headers and validates totals against source line items before handoff',
            'Renders sharp charts with bundled CJK & Latin fonts — never tofu boxes',
          ],
          stageFooterNote: 'All workbook reading and writing happens locally on your machine',
        },
        {
          id: 'ppt',
          icon: 'slides',
          label: 'Editable PowerPoint Decks',
          description:
            'Turn notes and metrics into clean, well-spaced slides where every title, shape, and chart remains editable.',
          deliverableTag: '.pptx',
          stageTitle: '2026_Product_Roadmap_Review.pptx',
          stagePrompt:
            'Create a 10-slide leadership deck from this annual roadmap doc covering KPIs, milestones, and risk mitigation.',
          stageHighlight: 'Native PPTX shapes · Overflow checks · Executive-ready pacing',
          stageBullets: [
            'Every text block, table, and chart stays a native PowerPoint element for quick edits',
            'Checks text fit and layout margins to avoid overlapping boxes and clipped labels',
            'Ideal for weekly standups, project kickoffs, client proposals, and training decks',
          ],
          stageFooterNote:
            'Preview slides right inside the EvoWork side pane before opening in PowerPoint',
        },
      ],
    },
    zeroBarrierSection: {
      title: 'Zero setup friction. Plug in your API key and go.',
      subtitle:
        'No Python environment to wrangle. No EvoWork account required. Download, paste a model key, and ship your first file in three minutes.',
      badge: 'Out of the Box · BYOK',
      steps: [
        {
          num: '01',
          title: 'Launch straight into the workspace',
          desc: 'The bundled office runtime verifies silently in the background—no multi-step installer wizard.',
        },
        {
          num: '02',
          title: 'Add your preferred model key',
          desc: 'Use DeepSeek, Kimi (Moonshot), GLM (Zhipu), MiMo, or any OpenAI-compatible API endpoint.',
        },
        {
          num: '03',
          title: 'Drop files and describe the goal',
          desc: 'Watch progress and inspect deliverables side by side, then open directly in your desktop apps.',
        },
      ],
      providersLabel: 'Works with leading model providers',
      providers: [
        { name: 'DeepSeek', note: 'V4 Pro / Flash · Step-by-step guide' },
        { name: 'Kimi (Moonshot)', note: 'K3.1 Pro · Great for long docs' },
        { name: 'GLM (Zhipu)', note: 'GLM 5.3 · Office-tested' },
        { name: 'OpenAI-Compatible', note: 'Any custom Base URL' },
      ],
      guideLinkLabel: 'Read the step-by-step API key guide',
      noAccountNote:
        'Your API keys are encrypted in your OS keychain, masked to the last 4 digits, and never sent to EvoWork.',
    },
    workflowSection: {
      title: 'From one-off files to dependable workflows',
      subtitle:
        'Read local archives, run recurring reports on schedule, cap budgets on long jobs, and save winning workflows as reusable skills.',
      items: [
        {
          id: 'library',
          icon: 'library',
          label: 'Local Library & Scan OCR',
          description:
            'Parse PDFs, Office docs, archives, and scanned pages locally—then search full text or cite with @.',
          deliverableTag: 'Local Library · OCR',
          stageTitle: 'Local Document Search & @ Citations',
          stagePrompt:
            '@2026-contracts Find every customer agreement mentioning quarterly rebates and summarize them in a table.',
          stageHighlight: 'On-device parsing & OCR · Paste screenshots anywhere with ⌘V / Ctrl+V',
          stageBullets: [
            'Drag in folders, zip archives, or paste clipboard screenshots directly into the composer',
            'Scanned PDFs run through local OCR so sensitive scans never leave your machine',
            'Type @ to anchor answers directly to specific files and library entries',
          ],
          stageFooterNote: 'Also imports existing project memories from Claude Code and WorkBuddy',
        },
        {
          id: 'schedule',
          icon: 'clock',
          label: 'Scheduled Automations',
          description:
            'Describe recurring work in plain language (“every Monday at 9 AM”) with automatic pause after 3 consecutive failures.',
          deliverableTag: 'Automations',
          stageTitle: 'Every Monday 09:00 · Weekly Report Draft',
          stagePrompt:
            'Every Monday at 9 AM, scan the Weekly Notes folder and prepare a clean team status report draft.',
          stageHighlight: 'Set once · Full run history · Auto-pauses on repeated errors',
          stageBullets: [
            'Supports daily, weekly, and monthly schedules plus active start/end date windows',
            'Pause or resume any schedule in one click with traceable run history',
            'Automatically pauses after 3 consecutive failures so it never burns tokens silently',
          ],
          stageFooterNote: 'Schedules execute locally inside the folders you explicitly authorize',
        },
        {
          id: 'goal',
          icon: 'target',
          label: 'Budget-Capped Long Tasks',
          description:
            'Use /goal to set an ongoing objective and a hard usage cap—pause anytime and resume from checkpoints.',
          deliverableTag: '/goal · Budget Guard',
          stageTitle: 'Long-Running Goal with Hard Budget Stop',
          stagePrompt:
            '/goal Extract financial tables from 12 annual PDFs and build a master rollup—stop immediately if budget is reached.',
          stageHighlight: 'Pause & resume across restarts · Kills background commands on stop',
          stageBullets: [
            'Pausing or hitting the budget cap truly stops the active turn and background commands',
            'Pick up right where you left off after an interruption without re-running completed steps',
            'Inspect per-task usage right in Settings so costs stay predictable',
          ],
          stageFooterNote:
            'Verified end-to-end against real pause/resume and budget exhaustion runs',
        },
        {
          id: 'skill',
          icon: 'spark',
          label: 'Turn Sessions into Reusable Skills',
          description:
            'Once a workflow clicks, extract it into a reusable skill—or install audited skills, experts, and connectors.',
          deliverableTag: 'Session-to-Skill · 74+ Hub Items',
          stageTitle: 'One Great Run → Reusable Team Skill',
          stagePrompt:
            'Extract our reconciliation checklist and formatting rules from this session into a project skill.',
          stageHighlight:
            'Save per-project or globally · Signed Hub with 34 skills, 31 experts & 9 connectors',
          stageBullets: [
            'Turn any finished conversation into a clean, reviewable skill draft without writing boilerplate',
            'Invoke saved skills anytime by typing / at the start of your message',
            'Build single-role experts or multi-agent teams right inside the local Agent Workbench',
          ],
          stageFooterNote:
            'Every external skill discloses its scripts and network hosts before installation',
        },
      ],
    },
    trustSection: {
      title: 'Work you can trust: your files stay on your computer',
      subtitle:
        'No fine print—these are the exact same privacy boundaries shown on first launch inside EvoWork.',
      localTitle: 'Stays on your computer',
      localBadge: 'Local-first · Raw files stay put',
      localItems: [
        'PDF, Word, Excel, PowerPoint, archive parsing, and scanned OCR run locally on your machine',
        'File edits, command execution, and scheduled automations stay on your device',
        'API keys are encrypted in your OS keychain and masked to the last four characters',
        'System directories, credential folders, and EvoWork settings are hard-blocked at all times',
      ],
      networkTitle: 'When it connects online',
      networkBadge: 'Transparent & model-only',
      networkItems: [
        'Only your prompts and relevant context go to the model provider you choose; EvoWork does not store them',
        'Live web lookups cite every source URL so you can verify claims quickly',
        'Installing a skill shows every script and external host before you approve',
        'Honest errors over silent fallbacks: if a model lacks vision or a feature is off, EvoWork tells you plainly',
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
            'Requires explicit confirmation to enable and scopes to one task. Even here, delete commands ask first.',
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
        'When you deny an action, EvoWork is tested not to sneak around it with an alternate command',
        'Open-source application code under the MIT license for independent inspection',
      ],
    },
    promptSection: {
      title: 'Copy a prompt and try real office workflows',
      subtitle: 'Click any card to copy the prompt—paste it into EvoWork with your own files.',
      clickHint: 'Click to copy',
      rows: [
        [
          {
            id: 'p-weekly',
            category: 'Daily Ops',
            title: 'Weekly Status Report',
            formatTag: '.docx',
            prompt:
              'Use this week’s notes in the folder to write an executive-first Word weekly report covering wins, next week’s plan, and blockers.',
          },
          {
            id: 'p-contract',
            category: 'Legal & Procurement',
            title: 'Scanned Contract Audit',
            formatTag: '.docx',
            prompt:
              'Run local OCR on this scanned supplier agreement and compile payment terms, liability caps, and auto-renewal risks into a cited Word table.',
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
            id: 'p-minutes',
            category: 'Meetings',
            title: 'Meeting Minutes & Owners',
            formatTag: '.docx',
            prompt:
              'Clean up these raw meeting notes into structured minutes with separate tables for Decisions Made and Action Items (owner + due date).',
          },
        ],
        [
          {
            id: 'p-research',
            category: 'Research',
            title: 'Cited Market Comparison',
            formatTag: '.docx',
            prompt:
              'Research 5 leading workplace AI tools online and compile a structured Word comparison of pricing, local privacy, and file outputs with source links.',
          },
          {
            id: 'p-batch',
            category: 'File Hygiene',
            title: 'Batch Invoice Rename & Ledger',
            formatTag: 'Local Batch',
            prompt:
              'Inspect the PDF invoices in this folder, propose a “Date_Vendor_Amount” rename plan for my approval, then build a summary Excel ledger.',
          },
          {
            id: 'p-schedule',
            category: 'Automation',
            title: 'Friday Delivery Digest',
            formatTag: 'Schedule',
            prompt:
              'Create a recurring automation: every Friday at 5 PM, summarize updates in the Project Log folder into a clean delivery digest.',
          },
          {
            id: 'p-email',
            category: 'Client Comms',
            title: 'Proposal Email & PDF Quote',
            formatTag: '.pdf',
            prompt:
              'Draft a crisp client follow-up email based on this pricing sheet and attach a clean one-page PDF quotation.',
          },
          {
            id: 'p-skill',
            category: 'Playbooks',
            title: 'Save Workflow as a Skill',
            formatTag: 'Custom Skill',
            prompt:
              'Extract the monthly close checklist and reconciliation steps we just completed into a reusable project skill.',
          },
        ],
      ],
    },
    bottomCta: {
      title: 'Leave the formatting and busywork to EvoWork',
      subtitle:
        'Download free for desktop—no account required. Plug in your API key and ship your first file in minutes.',
      primaryLabel: 'Go to Downloads',
      secondaryLabel: 'Enterprise / Book a Demo',
    },
  },
  download: {
    eyebrow: `Latest Release v${SITE_CONFIG.version} · Free & Open Source`,
    title: 'Download EvoWork and ship your first file in 3 minutes',
    subtitle:
      'Comes with the full office runtime and CJK/Latin fonts bundled inside—no Python setup or account sign-up required.',
    detectedLabel: 'Recommended for your system',
    downloadButton: 'Download Now',
    requirementsLabel: 'Requirements',
    checksumLabel: 'Release notes',
    unavailableNotice:
      'Honest note: Installers are currently available for Apple Silicon Macs (M1–M4) and 64-bit Windows. Intel Mac and Linux builds are not available yet.',
    platforms: [
      {
        id: 'macos',
        name: 'macOS (Apple Silicon)',
        arch: 'arm64 · DMG Disk Image',
        badge: 'Apple Silicon (M-Series)',
        fileName: `EvoWork-${SITE_CONFIG.version}-mac-arm64-unsigned.dmg`,
        sizeText: '~295 MB (includes offline office runtime & fonts)',
        requirements: 'macOS 13 or later · Apple M1 / M2 / M3 / M4',
        url: SITE_CONFIG.links.macArm64Dmg,
        sha256Hint: 'Unsigned build — see the one-line Terminal command below for first launch',
        highlights: [
          'Drag to Applications and launch—office runtime verifies automatically in the background',
          'Full local document parsing, on-device OCR, and experimental Computer Use',
          'Check for updates inside Settings with zero forced upgrades',
        ],
      },
      {
        id: 'windows',
        name: 'Windows (64-bit)',
        arch: 'x64 · Guided Installer',
        badge: 'Windows 10 / 11',
        fileName: `EvoWork-${SITE_CONFIG.version}-win-x64-setup.exe`,
        sizeText: 'Guided installer with custom directory & shortcuts',
        requirements: 'Windows 10 / 11 (64-bit)',
        url: SITE_CONFIG.links.windowsSetupExe,
        sha256Hint: 'Supports in-app silent upgrades and automatic relaunch for installed versions',
        highlights: [
          'Interactive setup wizard with custom install folder and shortcut choices',
          'Installed versions upgrade silently in-app and relaunch cleanly',
          'Includes the same offline office runtime and bundled fonts out of the box',
        ],
      },
    ],
    unsignedGuide: {
      badge: 'macOS First Launch Note (Temporary while unsigned)',
      title: 'Seeing “EvoWork is damaged and can’t be opened” on macOS?',
      subtitle:
        'The file is not damaged. Because current builds are not yet notarized with an Apple Developer ID, macOS Gatekeeper blocks first launch. Run this single command in Terminal after dragging EvoWork into Applications (this step will disappear once notarization is in place).',
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
      title: 'Click “Run anyway” if Windows SmartScreen prompts',
      body: 'Use the installer wizard to pick your folder and shortcuts. Future updates can be installed silently from Settings → About & Updates.',
    },
    quickStartTitle: '3 steps to your first finished deliverable',
    quickStartSubtitle: 'No EvoWork sign-up, no terminal configuration, no extra office plugins.',
    quickStartSteps: [
      {
        number: '01',
        title: 'Open EvoWork straight into the workspace',
        description:
          'Skip lengthy onboarding. The bundled office runtime validates silently in the background, and task folders stay neatly organized (changeable anytime in Settings → General).',
      },
      {
        number: '02',
        title: 'Add a model API key in Settings → Models',
        description:
          'Paste a key from DeepSeek, Kimi (Moonshot), GLM (Zhipu), or any OpenAI-compatible provider. Keys are stored encrypted in your OS keychain.',
        action: {
          label: 'Read the step-by-step API key guide',
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
    changelogTitle: 'Recent Releases',
    changelogSubtitle:
      'Steady, tested desktop releases—highlighted straight from our repository changelog.',
    changelogReleases: [
      {
        version: '0.6.5',
        label: 'Latest',
        items: [
          'New Windows guided installer with custom directory/shortcut selection and silent in-app upgrades',
          'Aligned Windows title bar with sidebar and kept window controls clickable in compact widths',
          'Preserved task titles when refreshing queued messages encounters an error',
        ],
      },
      {
        version: '0.6.4',
        label: 'Polish & Reliability',
        items: [
          'Full copy/paste context menu, global ⌘V screenshot paste, and queued attachments while sending',
          'Atomic token deletion for / skills and @ file references; IME composition and emails no longer trigger menus',
          'Pausing a task or exhausting a /goal budget cleanly halts active turns and background commands',
          'Added model recognition for DeepSeek V4 Pro, Kimi K3.1 Pro, and GLM 5.3',
        ],
      },
      {
        version: '0.6.1 – 0.6.2',
        label: 'Agents & Curated Experts',
        items: [
          'Create single experts or multi-agent teams locally, and install curated experts from the signed Hub',
          'Extract reusable project/global skills from finished sessions; import memories from Claude Code & WorkBuddy',
          'Signed Hub expiry visibility and zero-download bundled office runtime',
        ],
      },
    ],
    viewAllReleasesLabel: 'View full changelog & source on GitHub',
  },
  docs: {
    title: 'Documentation',
    subtitle:
      'Plain-language guides for everyday office work—from plugging in an API key to verifying every privacy boundary.',
    searchPlaceholder: 'Search guides (e.g. DeepSeek, PPT, OCR, schedule, privacy)…',
    emptySearch: 'No matching guides found. Try searching for “API key”, “Word”, or “privacy”.',
    onThisPage: 'On this page',
    previousLabel: 'Previous',
    nextLabel: 'Next',
    groups: [
      { id: 'getting-started', label: 'Getting Started' },
      { id: 'office', label: 'Office Workflows' },
      { id: 'workflow', label: 'Power Features' },
      { id: 'security', label: 'Security & Boundaries' },
      {
        id: 'developers',
        label: 'Developers & Open Source',
        collapsible: true,
        defaultCollapsed: true,
      },
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
              'Download the installer for your operating system from the Download page. EvoWork bundles its own offline office runtime and fonts, so you never have to install Python or configure command-line packages.',
            ],
            bullets: [
              'macOS (Apple Silicon): Drag EvoWork into Applications. While builds remain unsigned, run xattr -cr /Applications/EvoWork.app once in Terminal.',
              'Windows (64-bit): Run the setup wizard, choose your directory and shortcuts, and launch.',
            ],
          },
          {
            id: 'first-launch',
            heading: '2. Straight into the Workspace',
            paragraphs: [
              'EvoWork opens straight to your workspace with no mandatory account sign-up and no blocking onboarding tour. The bundled office runtime verifies asynchronously in the background.',
              'Tasks started without a project folder are saved neatly in a dedicated default directory, which you can change anytime under Settings → General.',
            ],
          },
          {
            id: 'first-task',
            heading: '3. Delegate Your First Office Task',
            paragraphs: [
              'Once you add an API key, drop in your source files (Excel, PDF, screenshots) and explain what you want the same way you would brief a colleague.',
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
        title: 'Connect a Model API Key (DeepSeek / Kimi / GLM)',
        summary:
          'No EvoWork account needed—get an API key from your preferred provider and paste it into Settings → Models.',
        readingTime: '4 min read',
        sections: [
          {
            id: 'why-byok',
            heading: 'Why Bring Your Own Key (BYOK)?',
            paragraphs: [
              'With BYOK, your prompts go straight to the model provider you pick and you pay only their usage rates—no mandatory EvoWork subscription. Your keys stay encrypted inside your operating system keychain and only display their last four characters.',
            ],
          },
          {
            id: 'deepseek-steps',
            heading: 'Example: Set Up DeepSeek in 4 Steps',
            paragraphs: [
              'For everyday work that includes screenshots or scanned images, choose deepseek-flash (vision + tool calling). For heavy multi-step analysis or long prose, try deepseek-v4-pro.',
            ],
            bullets: [
              'Step 1: Open platform.deepseek.com in your browser and sign in.',
              'Step 2: Check your API balance under Usage (API credits are separate from free web chat).',
              'Step 3: Go to API keys → Create API key, and copy it immediately—keys are shown in full only once.',
              'Step 4: Open EvoWork Settings → Models, choose DeepSeek (Base URL: https://api.deepseek.com), paste the key, and test.',
            ],
            code: 'Base URL: https://api.deepseek.com\nRecommended models: deepseek-flash (vision + tools) / deepseek-v4-pro',
          },
          {
            id: 'other-models',
            heading: 'Kimi, GLM, and Any OpenAI-Compatible Endpoint',
            paragraphs: [
              'EvoWork ships with protocol adapters for Kimi (Moonshot K3.1 Pro), GLM (Zhipu GLM 5.3), Xiaomi MiMo, and standard OpenAI-compatible APIs. You can save multiple keys and switch models anytime.',
            ],
            callout: {
              tone: 'warn',
              title: 'Keep your API key private',
              body: 'Never share your key publicly or commit it to documents. If you suspect a leak, revoke it immediately in your model provider console.',
            },
          },
        ],
      },
      {
        slug: 'office-deliverables',
        groupId: 'office',
        title: 'Guide to Word, Excel & PowerPoint Deliverables',
        summary:
          'How EvoWork produces clean layouts, verified Excel formulas, and editable slide decks.',
        readingTime: '4 min read',
        sections: [
          {
            id: 'word-pdf',
            heading: 'Word Documents & PDF Export',
            paragraphs: [
              'EvoWork generates .docx files with clean A4 defaults, bundled CJK/Latin fonts, structured headings, and pagination awareness—ideal for weekly reports, memos, and contract reviews. Export to PDF or open directly in Word/WPS from the result panel.',
            ],
          },
          {
            id: 'excel-charts',
            heading: 'Excel Workbooks & Data Charts',
            paragraphs: [
              'When consolidating spreadsheets or reconciling budgets, EvoWork inspects actual headers, writes live editable Excel formulas, and cross-checks summary totals against raw rows. Charts render with bundled fonts so Chinese and English labels stay crisp.',
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
              body: 'Deliverable polish on 10+ slide decks or multi-sheet financial models depends on the reasoning quality of the model you choose. Pick a flagship model for complex layouts.',
            },
          },
        ],
      },
      {
        slug: 'library-and-ocr',
        groupId: 'office',
        title: 'Local Library, Screenshot Paste & Scan OCR',
        summary:
          'Read PDFs, Office files, archives, and scanned documents locally without uploading raw files to the cloud.',
        readingTime: '3 min read',
        sections: [
          {
            id: 'supported-files',
            heading: 'Supported File Formats',
            paragraphs: [
              'Drag files into the composer, pick folders, or hit ⌘V / Ctrl+V anywhere in the window to paste screenshots directly into your current draft.',
            ],
            bullets: [
              'Documents & slides: PDF, Word (.docx), PowerPoint (.pptx), Markdown, TXT, RTF',
              'Spreadsheets & data: Excel (.xlsx), CSV, TSV',
              'Images & archives: JPG / PNG / GIF / BMP, ZIP / RAR archives, and source code files',
            ],
          },
          {
            id: 'local-ocr',
            heading: 'On-Device OCR & @ Citations',
            paragraphs: [
              'Scanned PDFs and contract photos are processed by a local OCR engine—original files stay on disk. Add recurring reference folders to your Library, then type @ in the composer to cite specific files or full-text matches.',
            ],
          },
        ],
      },
      {
        slug: 'automations-and-goals',
        groupId: 'workflow',
        title: 'Automations, /goal Budget Caps & Session-to-Skill',
        summary:
          'Schedule recurring reports, keep long tasks on budget, and turn winning runs into reusable skills.',
        readingTime: '4 min read',
        sections: [
          {
            id: 'automations',
            heading: 'Scheduled Automations',
            paragraphs: [
              'Describe recurring work in plain language—such as “Every Monday at 9 AM, compile last week’s notes into a team report draft.” Set optional active date ranges, pause or resume anytime, and rely on automatic pausing after 3 consecutive failures.',
            ],
          },
          {
            id: 'goal-budget',
            heading: 'Keep Long Tasks Controlled with /goal',
            paragraphs: [
              'Start a message with /goal to define a multi-step objective with a usage cap. You can pause and resume across app restarts, and hitting the cap immediately halts active turns and terminates background commands.',
            ],
            code: '/goal Extract tables from 10 vendor PDFs into one Excel rollup and stop when budget is reached',
          },
          {
            id: 'session-to-skill',
            heading: 'Extract Reusable Skills from Finished Sessions',
            paragraphs: [
              'Once a task produces the exact format you want, extract it into a project or global skill from the task menu or in plain language. Review the generated draft, save it, and invoke it next time by typing / at the start of your prompt.',
            ],
          },
        ],
      },
      {
        slug: 'security-and-boundaries',
        groupId: 'security',
        title: 'Security Model, Approval Tiers & Honest Limits',
        summary:
          'Clear documentation of what stays local, how approvals work, and what EvoWork does not do yet.',
        readingTime: '3 min read',
        sections: [
          {
            id: 'privacy-statement',
            heading: 'Where Does Your Data Go?',
            paragraphs: [
              'Document parsing, OCR, command execution, and scheduled automations run locally on your machine. Parsing never uploads your raw files to a cloud backend.',
              'Model inference requires internet access: prompts and relevant context are sent to the model provider you select. EvoWork’s local gateway does not retain them.',
            ],
          },
          {
            id: 'approval-tiers',
            heading: 'Approval Tiers & Hard Guardrails',
            paragraphs: [
              '“Ask to Approve” is the default tier—EvoWork asks before editing files outside your workspace or using the internet. “Full Access” requires confirmation and scopes only to the current task.',
            ],
            bullets: [
              'Deleting or overwriting existing files asks for confirmation with exact file paths—even under Full Access, delete commands prompt first.',
              'System folders, credential directories, and EvoWork’s own configuration are hard-blocked across all tiers.',
              '“Approve for Me” (automated risk review) is not enabled yet and is explicitly grayed out in the UI.',
            ],
          },
          {
            id: 'honest-limits',
            heading: 'Current Known Boundaries',
            paragraphs: ['We prefer spelling out limits upfront rather than hiding them:'],
            bullets: [
              'Installers currently cover Apple Silicon Macs and 64-bit Windows (no Intel Mac or Linux installers yet).',
              'macOS installers are not notarized yet and require one Terminal xattr command on first launch.',
              'Computer Use (controlling other desktop apps) remains experimental and macOS-only.',
            ],
          },
        ],
      },
      {
        slug: 'developers-open-source',
        groupId: 'developers',
        title: 'Build from Source, Licensing & Contributing',
        summary:
          'Architecture overview, verification commands, and open-source boundaries for developers.',
        readingTime: '3 min read',
        sections: [
          {
            id: 'stack',
            heading: 'Tech Stack & Open-Source License',
            paragraphs: [
              'The desktop app uses Electron + React + TypeScript with a local Node.js service layer and unified model gateway. Repository code is MIT licensed, paired with an Apache-2.0 execution kernel maintained via strict, minimal patches.',
            ],
            code: 'pnpm install\npnpm run check   # format · lint · typecheck · tests · patch budget · protocol · notices\npnpm run build',
          },
          {
            id: 'contribute',
            heading: 'Issues & Custom Extensions',
            paragraphs: [
              'Report bugs or unexpected agent actions on GitHub Issues, or extend EvoWork locally using SKILL.md skill packs and standard MCP connectors.',
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
      'Keep raw documents on employee machines while centralizing identity, model quotas, signed policy packs, and audit trails—empowering teams without compromising security.',
    primaryCta: 'Book a Demo & Consultation',
    secondaryCta: 'Explore Governance Model',
    modesTitle: 'Choose the deployment model that fits your security posture',
    modesSubtitle:
      'One desktop app and unified governance protocol—without forcing sensitive files onto a public cloud.',
    modes: [
      {
        id: 'cloud',
        badge: 'Fastest Start',
        title: 'Managed Cloud Organization',
        summary:
          'Turnkey online accounts, shared model gateway, and per-member quota controls—roll out to teams in a day.',
        points: [
          'Admins configure approved models and usage quotas centrally so staff never manage API keys',
          'File parsing and task execution remain on each employee’s computer',
          'Member invitations, usage alerts, and instant device revocation out of the box',
        ],
      },
      {
        id: 'private',
        badge: 'Most Popular',
        title: 'Private On-Prem / VPC Deployment',
        summary:
          'Host identity, enterprise model gateway, policy distribution, and audit services inside your own network.',
        points: [
          'Full egress control—route to self-hosted LLMs or approved commercial endpoints',
          'Distribute signed policy packs controlling allowed models, feature switches, and guardrails',
          'Revoke device sessions and refresh tokens centrally upon offboarding',
        ],
      },
      {
        id: 'airgapped',
        badge: 'Dedicated Delivery',
        title: 'Fully Air-Gapped Deployment',
        summary:
          'Built for regulated environments where installers, office runtimes, plugin hubs, and models stay 100% offline.',
        points: [
          'All external network dependencies disabled with zero silent fallback to the public internet',
          'Bundled offline office runtime and internally signed plugin repository',
          'Joint acceptance testing tailored to your internal network environment',
        ],
      },
    ],
    governanceTitle: 'Governance separated from content by design',
    governanceSubtitle:
      'Admins govern permissions and spend while never exposing employee local documents on the control plane.',
    governanceCards: [
      {
        title: 'Zero task content on the admin portal',
        description:
          'The tenant console manages members, default models, quotas, and policy packs—its APIs and database schemas contain no task prompts or local file content.',
      },
      {
        title: 'Signed policy packs with rollout visibility',
        description:
          'Review diffs before issuing signed policies, track active rollout coverage across devices, inspect history, or revoke immediately.',
      },
      {
        title: 'Device revocation & audit export',
        description:
          'Inspect active devices per user, revoke one or all other devices in one click, and export identity/admin audit logs to CSV.',
      },
    ],
    statusTitle: 'Honest enterprise capability status',
    statusSubtitle:
      'True to EvoWork’s engineering culture, we clearly separate shipped capabilities from staged pilot items.',
    statusColumns: ['Capability', 'Status', 'Details'],
    statusRows: [
      {
        capability: 'HTTPS accounts, email verification & PKCE auto-refresh',
        status: 'ready',
        statusLabel: 'Shipped',
        detail:
          'Production HTTPS flow, OS keychain token storage, and non-disruptive background renewal.',
      },
      {
        capability: 'Tenant Admin Console (invites, quotas, models, signed policies, CSV audit)',
        status: 'ready',
        statusLabel: 'Shipped',
        detail:
          'Dedicated Web console (account.nucleant.cn) strictly isolated from local task content.',
      },
      {
        capability: 'Signed Plugin Hub & bundled offline office runtime',
        status: 'ready',
        statusLabel: 'Shipped',
        detail:
          'Ed25519 signed catalog verification, expiry visibility, and zero-download desktop office runtime.',
      },
      {
        capability: 'Enterprise SSO (OIDC/SAML) & directory group sync',
        status: 'planned',
        statusLabel: 'Pilot / Planned',
        detail: 'Architecture specified; available for joint integration with pilot customer IdPs.',
      },
      {
        capability: 'Reviewed team/department shared memory & task status updates',
        status: 'planned',
        statusLabel: 'Staged Rollout',
        detail:
          'Explicit opt-in publishing with role permissions; local auto-memory stays strictly private.',
      },
    ],
    booking: {
      title: 'Book a Demo or Discuss Private Deployment',
      subtitle:
        'Tell us about your team and workflows—we will get back within 1–2 business days to schedule a live walkthrough.',
      expectationsTitle: 'What you will get from the session',
      expectations: [
        'A live desktop demo tailored to your team’s real files (finance, legal, ops, or engineering)',
        'Architecture review of local privacy boundaries, egress controls, and on-prem sizing',
        'Guidance for piloting the tenant admin console and unified model gateway',
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
          'Custom LLM or internal skills integration',
          'Security & compliance review',
        ],
        notesLabel: 'Workflow notes (optional)',
        notesPlaceholder:
          'e.g. Our finance and legal teams need local contract review and monthly Excel rollups with an internal LLM…',
        consentText:
          'I agree that the EvoWork team may use these details to respond to my inquiry.',
        submitLabel: 'Request a Demo',
        submittingLabel: 'Submitting…',
        previewModeNote:
          'No live lead endpoint is configured in this build—submitting shows a validated preview receipt with a direct email fallback.',
        validationName: 'Please enter your name',
        validationEmail: 'Please enter a valid work email address',
        validationCompany: 'Please enter your company or team name',
        validationConsent: 'Please confirm permission for us to contact you',
        successTitle: 'Request received',
        successBody:
          'Thanks for reaching out! We have received your demo request and will reply via email within 1–2 business days.',
        successPreviewBody:
          'This build is running in endpoint-free preview mode and your form passed validation. Set VITE_LEAD_ENDPOINT to connect a live Webhook or API, or use the direct email button below.',
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
    licenseNote: 'MIT Open Source · Local-first desktop AI work assistant',
    links: [
      { label: 'Download', page: 'download' },
      { label: 'Docs', page: 'docs', docSlug: 'quick-start' },
      { label: 'Security', page: 'docs', docSlug: 'security-and-boundaries' },
      { label: 'Enterprise', page: 'enterprise' },
      { label: 'Account Portal', href: SITE_CONFIG.links.accountPortal, external: true },
      { label: 'GitHub', href: SITE_CONFIG.links.github, external: true },
    ],
  },
};
