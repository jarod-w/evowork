import { SITE_CONFIG } from '../config.js';
import type { SiteContent } from '../types.js';

export const ZH_CONTENT: SiteContent = {
  locale: 'zh',
  htmlLang: 'zh-CN',
  meta: {
    siteName: 'EvoWork',
    tagline: '一句话交代工作，拿回能直接用的文件',
    pageTitles: {
      home: 'EvoWork — 一句话交代工作，拿回能直接用的文件',
      download: '下载与 3 分钟上手 — EvoWork',
      docs: '文档中心 — EvoWork',
      enterprise: '企业版与私有化部署 — EvoWork',
    },
  },
  common: {
    copied: '已复制',
    copyCommand: '复制命令',
    copyPrompt: '复制提示词',
    switchLocaleLabel: 'EN',
    menuOpen: '打开导航菜单',
    menuClose: '关闭导航菜单',
    accountLogin: '账号登录',
    backToTop: '返回顶部',
    openSourceBadge: `v${SITE_CONFIG.version} · MIT 开源`,
  },
  nav: {
    items: [
      { page: 'home', label: '首页' },
      { page: 'download', label: '下载上手' },
      { page: 'docs', label: '文档' },
      { page: 'enterprise', label: '企业版' },
    ],
    bookDemo: '预约演示',
    downloadForOs: {
      macos: '下载 macOS 版',
      windows: '下载 Windows 版',
    },
    downloadGeneric: '下载桌面版',
  },
  home: {
    eyebrow: `EvoWork v${SITE_CONFIG.version} · 桌面端 AI 办公工作台`,
    headline: '一句话交代工作，拿回能直接用的文件',
    subheadline:
      '把周报、合同、数据表格和季度汇报交给装在电脑里的 AI 办公助手。它会自动规划、本机解析资料并核对结果，直接交付排版好的 Word、Excel 和 PPT 成品。',
    primaryCta: {
      macos: '免费下载 macOS 版',
      windows: '免费下载 Windows 版',
    },
    secondaryCta: '3 分钟上手指南',
    trustStrip: [
      '文件留在本机处理',
      '无需注册账号即可使用',
      '随包自带办公环境与中文字体',
      'MIT 开源可审计',
    ],
    stageCaption: '交互演示：点击上方场景标签，预览 EvoWork 如何从一句话交付完整办公文件',
    heroScenes: [
      {
        id: 'sales-report',
        tabLabel: '月度销售汇总 + 汇报 PPT',
        taskTitle: '整理 10 月区域销售表并出汇报',
        prompt:
          '根据文件夹里 3 个大区的 10 月销售明细表，核对各渠道环比与达成率，生成一份汇总 Excel 和 8 页季度复盘 PPT。',
        modeTag: '请求批准',
        modelTag: 'DeepSeek / Kimi / GLM',
        steps: [
          { text: '本机读取 3 份 .xlsx 明细，核对 240 行表头与口径', status: 'done' },
          { text: '校验 Excel 汇总公式与原表勾稽，确认零偏差', status: 'done' },
          { text: '生成带中文字体图表的 8 页可编辑 PPTX 与汇总表', status: 'done' },
        ],
        deliverableName: '10月销售复盘汇总.xlsx + 季度复盘.pptx',
        deliverableKind: 'xlsx',
        deliverableBadge: '成品已生成 · 可直接打开',
        previewHeading: '2026 年 10 月区域销售达成汇总',
        previewSubheading: '公式已回写校验 · 中文字体图表无乱码 · A4/16:9 成品就绪',
        previewMetrics: [
          { label: '总营收', value: '¥ 1,284 万' },
          { label: '目标达成率', value: '108.4%' },
          { label: '环比增长', value: '+14.2%' },
        ],
        previewRows: [
          { col1: '华东大区', col2: '¥ 562 万', col3: '112.4% 达成', tone: 'good' },
          { col1: '华南大区', col2: '¥ 418 万', col3: '106.1% 达成', tone: 'good' },
          { col1: '华北大区', col2: '¥ 304 万', col3: '101.8% 达成', tone: 'neutral' },
        ],
      },
      {
        id: 'contract-audit',
        tabLabel: '扫描件合同审查 → 风险表',
        taskTitle: '审查供应商年度框架协议（扫描 PDF）',
        prompt:
          '把这份 26 页的扫描版供应商合同做一次全面审查，把付款节点、违约责任和隐性续约条款整理成 Word 审查意见表。',
        modeTag: '请求批准',
        modelTag: '本机 OCR + 模型分析',
        steps: [
          { text: '本机 OCR 识别 26 页扫描 PDF，原文未上传云端', status: 'done' },
          { text: '比对常见商务风控条款，定位 4 处高风险约定', status: 'done' },
          { text: '输出 A4 排版 Word 审查意见表（含原页码与修改建议）', status: 'done' },
        ],
        deliverableName: '供应商框架协议_风险审查表.docx',
        deliverableKind: 'docx',
        deliverableBadge: 'A4 成品 · 已标注页码',
        previewHeading: '合同核心风险点与修改建议',
        previewSubheading: '本地 OCR 识别 · 标注原合同页码 · 可直接发给法务/业务复核',
        previewMetrics: [
          { label: '识别页数', value: '26 页' },
          { label: '高风险项', value: '2 处' },
          { label: '建议修订', value: '4 条' },
        ],
        previewRows: [
          {
            col1: '第 9 页 · 违约金上限',
            col2: '未设总额封顶',
            col3: '高风险 · 建议限 20%',
            tone: 'warn',
          },
          {
            col1: '第 14 页 · 自动续约',
            col2: '提前 60 天书面通知',
            col3: '中风险 · 建议改 30 天',
            tone: 'warn',
          },
          { col1: '第 19 页 · 验收期限', col2: '15 个工作日确认', col3: '符合标准', tone: 'good' },
        ],
      },
    ],
    deliverablesSection: {
      title: '交付能直接发出去的办公成品',
      subtitle:
        '不用从聊天框来回复制、调格式、修图表方块字。安装包自带完整办公运行时与中文字体，开箱就能产出可编辑文件。',
      items: [
        {
          id: 'word',
          icon: 'doc',
          label: 'Word 文档与报告',
          description: '周报、方案、合同审查、会议纪要。默认 A4 排版、层级清晰，支持一键导出 PDF。',
          deliverableTag: '.docx / .pdf',
          stageTitle: '市场竞品季度分析报告.docx',
          stagePrompt:
            '整理这 5 份调研笔记与公开资料，写一份带执行摘要、对比表格和风险建议的正式 Word 报告。',
          stageHighlight: '默认 A4 纸张 · 标题/目录/页码自动规范 · 中文字体完整嵌入',
          stageBullets: [
            '自动生成结论先行摘要、章节层级与对比表格，无需手动二次调行距',
            '联网补充公开信息时自动附带来源链接，方便复核出处',
            '完成后可直接调用本机 Word / WPS 打开，或直接导出 PDF 发送',
          ],
          stageFooterNote: '内置文档排版与分页检查，避免内容被静默截断',
        },
        {
          id: 'excel',
          icon: 'table',
          label: 'Excel 表格与数据图表',
          description: '自动清洗、透视、写公式并做明细与汇总独立勾稽，图表中文清清楚楚。',
          deliverableTag: '.xlsx / .png',
          stageTitle: 'Q3费用报销与预算偏差表.xlsx',
          stagePrompt:
            '把 3 个部门的费用明细合并成总表，按科目计算同比偏差，并在第二个工作表生成可视化图表。',
          stageHighlight: '保留真实 Excel 公式 · 原始明细与汇总数独立核对 · 图表零方块字',
          stageBullets: [
            '写入真正可编辑的 SUM / SUMIFS 等公式，而不是写死的静态数字',
            '对大表做表头映射与口径核对，避免把增量当余额的常见低级错误',
            '随包中文字体渲染统计图表，直接嵌入工作表或独立保存高清图',
          ],
          stageFooterNote: '全流程在本机完成表格读写，财务与业务原表无需传给第三方网盘',
        },
        {
          id: 'ppt',
          icon: 'slides',
          label: 'PPT 演示文稿',
          description: '从零散素材直接产出结构清晰、版面干净、每页都能二次编辑的幻灯片。',
          deliverableTag: '.pptx',
          stageTitle: '2026_产品路线与业务汇报.pptx',
          stagePrompt:
            '根据这份年度规划文档，做一份 10 页管理层汇报 PPT，包含核心数据页、里程碑页与风险应对页。',
          stageHighlight: '原生可编辑元素 · 布局防溢出检查 · 商务简约视觉风格',
          stageBullets: [
            '标题、正文、卡片、数据图表均为标准 PPT 对象，拿回去随时能改字换图',
            '自动校验文字字号与页面边界，减少重叠、裁切和拥挤排版',
            '适合周会汇报、项目立项、客户提案与培训课件',
          ],
          stageFooterNote: '无需安装外部插件，生成后在右侧即可实时预览翻页效果',
        },
      ],
    },
    zeroBarrierSection: {
      title: '零门槛上手，接上你的模型就能用',
      subtitle:
        '不用折腾 Python 环境，也不用注册 EvoWork 账号。下载打开、填一把模型密钥，三分钟开始干活。',
      badge: '开箱即用 · BYOK',
      steps: [
        {
          num: '01',
          title: '下载即进入主界面',
          desc: '办公运行环境与中文字体随包自带、后台自动验证，没有冗长初始化引导。',
        },
        {
          num: '02',
          title: '填入你常用的模型密钥',
          desc: '支持 DeepSeek、Kimi（Moonshot）、GLM（智谱）、MiMo 或任意 OpenAI 兼容接口。',
        },
        {
          num: '03',
          title: '拖入资料，说一句话发送',
          desc: '右侧实时查看产物和文件变更，满意后直接用本机应用打开或发出。',
        },
      ],
      providersLabel: '原生适配主流模型接口',
      providers: [
        { name: 'DeepSeek', note: 'V4 Pro / Flash · 图文教程完备' },
        { name: 'Kimi (Moonshot)', note: 'K3.1 Pro · 长文本友好' },
        { name: 'GLM (智谱)', note: 'GLM 5.3 · 办公表格实测' },
        { name: 'OpenAI 兼容', note: '自定义 Base URL 自由接入' },
      ],
      guideLinkLabel: '查看 DeepSeek 密钥获取图文教程',
      noAccountNote: '密钥使用系统钥匙串加密保存在本机，界面仅展示后四位，绝不上传给 EvoWork。',
    },
    workflowSection: {
      title: '从单次任务，到省心的自动工作流',
      subtitle:
        '不仅能帮你做好眼前的这份文档，还能读懂电脑里的历史资料、按时自动交付，并把好用的做法沉淀下来。',
      items: [
        {
          id: 'library',
          icon: 'library',
          label: '读懂本地资料与扫描件',
          description: 'PDF、Word、Excel、PPT、压缩包与扫描件全在本机解析，资料库支持按正文搜索。',
          deliverableTag: '本地资料库 · OCR',
          stageTitle: '本地资料库与跨文件检索',
          stagePrompt: '@2026合同归档 找出所有含「季度返点」条款的客户协议，汇总成对比清单。',
          stageHighlight: '本机解析 + 本机 OCR · 输入 @ 精准引用文件夹与附件',
          stageBullets: [
            '直接粘贴截图（⌘V / Ctrl+V）或拖入多个文件与压缩包',
            '扫描版 PDF 和图片单据走本机 OCR，原始文件不离开电脑',
            '通过 @ 快速引用指定资料库文档，回答更聚焦、少幻觉',
          ],
          stageFooterNote: '支持导入 Claude Code 与 WorkBuddy 已有项目记忆',
        },
        {
          id: 'schedule',
          icon: 'clock',
          label: '定时自动执行',
          description: '用自然语言约定「每周一早上 9 点生成周报」，连续失败 3 次自动暂停不空跑。',
          deliverableTag: '自动化 · Automations',
          stageTitle: '每周一 09:00 自动汇总周报',
          stagePrompt:
            '每周一上午 9 点扫描「本周进展」目录里的记录，生成团队周报草稿并提醒我确认。',
          stageHighlight: '一次配置长期省心 · 每次执行留存历史 · 异常自动熔断',
          stageBullets: [
            '支持每日 / 每周 / 每月周期运行，也支持设定生效起止日期',
            '随时一键暂停或恢复，每次产出结果清晰可追溯',
            '连续失败 3 次自动暂停并提示原因，避免后台悄悄反复消耗额度',
          ],
          stageFooterNote: '定时调度在本机运行，只在你授权的目录里干活',
        },
        {
          id: 'goal',
          icon: 'target',
          label: '长任务预算可控',
          description: '用 /goal 设定持续目标与用量预算，可随时暂停接着做，预算用完立刻停住。',
          deliverableTag: '/goal · 预算闸门',
          stageTitle: '长程任务检查点与预算保护',
          stagePrompt: '/goal 完成 12 份行业年报的数据抽取、核对与汇总报告，用量达到上限立即停止。',
          stageHighlight: '进度随时可暂停/恢复 · 预算耗尽强制停手并回收后台命令',
          stageBullets: [
            '中途点暂停或预算到达上限，正在跑的回合和后台命令都会真正停下',
            '中断后重启应用也能基于检查点接着做，不重头浪费时间和费用',
            '设置页透明查看每次任务用量，不再担心“跑飞烧光余额”',
          ],
          stageFooterNote: '已通过真实长任务暂停/恢复与预算停止回归验证',
        },
        {
          id: 'skill',
          icon: 'spark',
          label: '把好用的做法提炼成技能',
          description:
            '一次任务跑顺了，一键从当前会话提炼为专属技能；还可从精选库安装或组建专家团队。',
          deliverableTag: '会话提炼技能 · 74+ 精选插件',
          stageTitle: '一次跑通 → 沉淀为团队复用技能',
          stagePrompt: '把刚才这套财务对账和异常处理步骤提炼成技能，保存到当前项目供每周复用。',
          stageHighlight: '支持项目级 / 全局保存 · 官方签名 Hub 收录 34 技能 / 31 专家 / 9 连接器',
          stageBullets: [
            '无需手写复杂规则，从成功完成的会话里自动整理成可审阅、可修改的技能草稿',
            '以后在输入框敲 / 就能直接调用，让每次输出都保持统一标准',
            '也能在「智能体工作台」配置单人专家或多智能体协作团队',
          ],
          stageFooterNote: '安装任何外部技能前都会明示要运行的脚本与外联地址',
        },
      ],
    },
    trustSection: {
      title: '放心交给它：你的文件始终在你的电脑里',
      subtitle: '不玩文字游戏——你在首次打开 EvoWork 时看到的隐私承诺，和这里一字不差。',
      localTitle: '全部留在你的电脑上',
      localBadge: '本机完成 · 不传原文',
      localItems: [
        'PDF、Word、Excel、PPT、压缩包解析与扫描件 OCR 全在本机运行',
        '文件读写、脚本执行与定时任务都在本机目录内完成',
        '模型 API 密钥通过系统钥匙串加密保存在本机，界面只显示后四位',
        '系统目录、凭据文件与 EvoWork 自身配置受硬拦截保护，不可越权',
      ],
      networkTitle: '需要联网时，去向透明',
      networkBadge: '按需发往你选的模型商',
      networkItems: [
        '只有提问与相关上下文发往你自己配置的模型服务商，EvoWork 网关不保存原文',
        '联网查资料时自动列出引用网页出处，方便人工核对',
        '安装插件/技能前会列出将运行的脚本与需要访问的网址，确认后才启用',
        '做不到就直说：缺组件、模型看不了图或功能未接通时明确提示，不悄悄降级糊弄',
      ],
      tiersTitle: '你决定它能自己做到哪一步',
      tiers: [
        {
          name: '请求批准（默认）',
          badge: '推荐日常使用',
          tone: 'accent',
          description: '修改工作空间外的文件或需要访问互联网之前，都会先弹出确认询问你。',
        },
        {
          name: '完全访问',
          badge: '仅对当前任务生效',
          tone: 'neutral',
          description: '开启前需二次确认，仅限当前任务。即使在此档位，删除文件命令仍会先问你一次。',
        },
        {
          name: '帮我批准',
          badge: '规划中 · 尚未接通',
          tone: 'muted',
          description: '按风险自动审查并只拦截高危动作。这一档目前尚未接通，应用内会明确置灰说明。',
        },
      ],
      guardrails: [
        '删除或覆盖已有文件前明确提示文件路径',
        '你点击拒绝后，不会偷偷换一条命令绕过执行',
        '应用代码采用 MIT 开源许可，欢迎随时审计',
      ],
    },
    promptSection: {
      title: '复制一句话，立即体验职场高频场景',
      subtitle: '点击任意卡片即可复制提示词，打开 EvoWork 粘贴发送就能试用。',
      clickHint: '点击复制',
      rows: [
        [
          {
            id: 'p-weekly',
            category: '日常办公',
            title: '多来源自动生成周报',
            formatTag: '.docx',
            prompt:
              '根据本目录本周的会议记录和工作流水，写一份结论先行的团队周报 Word，含本周进展、下周计划和风险项。',
          },
          {
            id: 'p-contract',
            category: '法务商务',
            title: '扫描合同风险点审查',
            formatTag: '.docx',
            prompt:
              '本机识别这份扫描版供应商合同，把付款条件、违约责任、知识产权和自动续约风险整理成 Word 审查表并标注页码。',
          },
          {
            id: 'p-excel',
            category: '数据财务',
            title: '多表合并与公式核对',
            formatTag: '.xlsx',
            prompt:
              '合并当前文件夹的 3 张区域销售表，按月份和产品线汇总，写入真实 Excel 公式核对总额，并生成趋势图。',
          },
          {
            id: 'p-ppt',
            category: '汇报演示',
            title: '季度复盘汇报 PPT',
            formatTag: '.pptx',
            prompt:
              '基于这份 Q3 总结文档，制作一份 10 页可编辑季度汇报 PPT，突出核心指标变化、关键项目复盘和下季目标。',
          },
          {
            id: 'p-minutes',
            category: '会议协作',
            title: '会议纪要与待办拆解',
            formatTag: '.docx',
            prompt:
              '将这份原始会议速记整理成规范会议纪要，单独抽出「决议事项」和「责任人 + 截止时间」行动清单表。',
          },
        ],
        [
          {
            id: 'p-research',
            category: '行业调研',
            title: '联网竞品调研报告',
            formatTag: '.docx',
            prompt:
              '联网调研国内外 5 款主流协同办公工具的定价与核心特性，整理一份带来源出处的对比研究报告 Word。',
          },
          {
            id: 'p-batch',
            category: '效率整理',
            title: '批量文件归档重命名',
            formatTag: '本机批处理',
            prompt:
              '扫描「待整理发票」文件夹里的 PDF，按「日期_开票方_金额」列出重命名方案，等我确认后再执行整理并生成台账 Excel。',
          },
          {
            id: 'p-schedule',
            category: '自动任务',
            title: '每周定时简报',
            formatTag: '定时任务',
            prompt:
              '帮我建一个定时任务：每周五下午 5 点整理「项目日志」里的更新，输出一份本周交付清单供我审阅。',
          },
          {
            id: 'p-email',
            category: '客户沟通',
            title: '英文商务邮件与报价单',
            formatTag: '.docx',
            prompt:
              '把这份中文产品报价说明改写成得体的英文商务回复邮件，并附一份排版干净的英文 PDF 报价单。',
          },
          {
            id: 'p-skill',
            category: '经验沉淀',
            title: '把成熟流程提炼为技能',
            formatTag: '专属技能',
            prompt:
              '把我们刚才完成月度财务核对的步骤和检查口径提炼成一个可复用技能，保存到当前项目里。',
          },
        ],
      ],
    },
    bottomCta: {
      title: '把繁琐的文档整理，交给 EvoWork',
      subtitle: '免费下载桌面版，无需注册账号，3 分钟接上你的模型开始交付成品。',
      primaryLabel: '前往下载页面',
      secondaryLabel: '咨询企业版 / 预约演示',
    },
  },
  download: {
    eyebrow: `最新版本 v${SITE_CONFIG.version} · 免费开源`,
    title: '下载 EvoWork，3 分钟开始第一次交付',
    subtitle: '随包内置完整办公环境与中文字体，打开就能用，无需手动安装 Python 或注册账号。',
    detectedLabel: '已为你推荐当前系统',
    downloadButton: '立即下载',
    requirementsLabel: '系统要求',
    checksumLabel: '发布说明',
    unavailableNotice:
      '坦诚说明：当前仅提供 Apple 芯片（M1–M4）macOS 与 Windows（x64）安装包，暂未提供 Intel Mac 与 Linux 安装包。',
    platforms: [
      {
        id: 'macos',
        name: 'macOS（Apple 芯片）',
        arch: 'arm64 · DMG 安装镜像',
        badge: 'Apple Silicon (M 系列)',
        fileName: `EvoWork-${SITE_CONFIG.version}-mac-arm64-unsigned.dmg`,
        sizeText: '约 295 MB（含随包办公运行时与中文字体）',
        requirements: 'macOS 13 及以上 · Apple M1 / M2 / M3 / M4',
        url: SITE_CONFIG.links.macArm64Dmg,
        sha256Hint: '首次打开若提示未签名，请见下方一键放行指引',
        highlights: [
          '拖入「应用程序」即可使用，办公运行时后台自动校验',
          '支持本机文档解析、扫描件 OCR 与实验性应用操控',
          '设置内一键检查更新，旧版本不会强制失效',
        ],
      },
      {
        id: 'windows',
        name: 'Windows（64 位）',
        arch: 'x64 · 向导安装程序',
        badge: 'Windows 10 / 11',
        fileName: `EvoWork-${SITE_CONFIG.version}-win-x64-setup.exe`,
        sizeText: '向导式安装包（支持自定义安装目录）',
        requirements: 'Windows 10 / 11（64 位）',
        url: SITE_CONFIG.links.windowsSetupExe,
        sha256Hint: '支持选择安装路径、创建快捷方式与应用内静默升级',
        highlights: [
          '全新向导式安装器，可自选安装目录与桌面快捷方式',
          '已安装版本支持应用内静默升级并自动重新打开',
          '同样随包自带办公运行时与中文字体，零额外配置',
        ],
      },
    ],
    unsignedGuide: {
      badge: 'macOS 首次打开必看（未签名阶段临时步骤）',
      title: '如果 macOS 提示「已损坏，无法打开」怎么办？',
      subtitle:
        '安装包本身完全正常。因为现阶段尚未接入 Apple Developer ID 公证签名，macOS Gatekeeper 会拦截未签名应用；在「终端」运行下面这一行即可正常打开（拿到签名证书后本步骤将取消）。',
      command: 'xattr -cr /Applications/EvoWork.app',
      note: '请先将 EvoWork 拖入「应用程序」文件夹，再打开「终端」粘贴并回车。',
      steps: [
        '双击下载的 .dmg 文件，将 EvoWork 图标拖进「应用程序」文件夹。',
        '打开系统自带的「终端（Terminal）」，复制右侧命令并粘贴回车。',
        '回到「应用程序」双击 EvoWork 即可直接进入主界面。',
      ],
    },
    windowsTip: {
      badge: 'Windows 安装提示',
      title: '遇到 SmartScreen 提示时点击「仍要运行」',
      body: '双击安装向导后可自由选择安装目录和快捷方式。后续发布新版本时，可直接在「设置 → 关于与更新」里静默升级并自动重启。',
    },
    quickStartTitle: '装好之后，3 步完成第一个任务',
    quickStartSubtitle: '不需要注册 EvoWork 账号，也不需要配置复杂的命令行环境。',
    quickStartSteps: [
      {
        number: '01',
        title: '打开 EvoWork，直接进入工作台',
        description:
          '首次打开无冗长引导，直接看到主界面。办公组件在后台自动完成验证；任务文件默认存在独立目录，可在「设置 → 常规」随时更改保存位置。',
      },
      {
        number: '02',
        title: '在「设置 → 模型」添加一把模型密钥',
        description:
          '任选你已有余额的 DeepSeek、Kimi（Moonshot）、GLM（智谱）或任意兼容 OpenAI 接口的服务填入即可。密钥用系统钥匙串加密存放在本机。',
        action: {
          label: '看 DeepSeek 密钥获取图文教程',
          page: 'docs',
          docSlug: 'api-key-setup',
        },
      },
      {
        number: '03',
        title: '拖入文件，用一句话说出你要什么',
        description:
          '回到首页，拖入表格或 PDF，输入例如「整理这几张表做一份月报 Word」。EvoWork 会在右侧展示完整进度与可直接打开的成品文件。',
        action: {
          label: '查看更多办公提示词与技巧',
          page: 'docs',
          docSlug: 'office-deliverables',
        },
      },
    ],
    changelogTitle: '近期版本更新记录',
    changelogSubtitle: '保持高频、扎实的工程迭代，以下摘自仓库真实更新记录。',
    changelogReleases: [
      {
        version: '0.6.5',
        label: '最新版本',
        items: [
          'Windows 升级为向导式安装，可自选目录与快捷方式，并支持应用内静默升级重启',
          '优化 Windows 标题栏与侧栏对齐，以及窄窗/折叠态的窗口控制按钮',
          '修复排队消息刷新失败时任务标题异常变动的问题',
        ],
      },
      {
        version: '0.6.4',
        label: '效率与体验收敛',
        items: [
          '输入框全面支持右键复制粘贴与焦点外 ⌘V 粘贴截图；发送途中粘贴的附件自动排队不丢失',
          '行首 / 选技能、@ 引用文件支持整块删除；输入法组字与邮箱地址不再误触菜单',
          '暂停任务或用量用完时，正在运行的回合与后台命令会真正停下',
          '支持识别 DeepSeek V4 Pro、Kimi K3.1 Pro 与 GLM 5.3',
        ],
      },
      {
        version: '0.6.1 – 0.6.2',
        label: '智能体与精选专家',
        items: [
          '支持在本机创建单体专家与多智能体协作团队，并从官方精选目录安装专家角色',
          '支持从任务会话一键提炼技能保存到项目或全局，以及导入 Claude Code / WorkBuddy 记忆',
          '插件目录透明显示签名有效期，内置办公运行时随包分发免联网安装',
        ],
      },
    ],
    viewAllReleasesLabel: '在 GitHub 查看完整更新日志与源码',
  },
  docs: {
    title: '文档中心',
    subtitle:
      '写给普通职场用户的清晰手册：从 3 分钟接入模型、产出漂亮办公成品，到看懂每一项安全边界。',
    searchPlaceholder: '搜索文档标题或关键词（如 DeepSeek、PPT、OCR、定时任务）…',
    emptySearch: '没有找到匹配的文档，试试换个关键词，如「密钥」「Word」「隐私」。',
    onThisPage: '本页目录',
    previousLabel: '上一篇',
    nextLabel: '下一篇',
    groups: [
      { id: 'getting-started', label: '快速开始' },
      { id: 'office', label: '高频办公指南' },
      { id: 'workflow', label: '效率进阶' },
      { id: 'security', label: '安全、隐私与边界' },
      { id: 'developers', label: '开发者与开源', collapsible: true, defaultCollapsed: true },
    ],
    articles: [
      {
        slug: 'quick-start',
        groupId: 'getting-started',
        title: '3 分钟安装与首次使用',
        summary: '从下载安装包到交付第一份 Word/Excel/PPT 成品的完整路径。',
        readingTime: '约 3 分钟',
        sections: [
          {
            id: 'install',
            heading: '1. 安装桌面应用',
            paragraphs: [
              '前往下载页获取对应系统的安装包。EvoWork 已将文档/表格/幻灯片生成所需的办公运行时与中文字体随包打包，无需你手动安装 Python 或配置命令行环境。',
            ],
            bullets: [
              'macOS（Apple 芯片）：拖进「应用程序」后，若当前为未签名版本，在终端执行一次 xattr -cr /Applications/EvoWork.app 即可打开。',
              'Windows（64 位）：运行安装向导，选择安装目录与快捷方式，完成后直接启动。',
            ],
          },
          {
            id: 'first-launch',
            heading: '2. 首次启动直达工作台',
            paragraphs: [
              '打开 EvoWork 后会直接进入主界面，无需注册账号，也没有冗长的初始化引导。应用会在后台异步验证随包办公组件是否就绪。',
              '没有指定项目文件夹的任务会自动保存在独立目录中；你可以随时在「设置 → 常规」修改默认保存路径。',
            ],
          },
          {
            id: 'first-task',
            heading: '3. 交代你的第一个办公任务',
            paragraphs: [
              '配置好任意一家模型密钥后，回到首页：直接拖入原始文件（如几张 Excel、PDF 或截图），用平时给同事交代工作的口吻说清目标和期望格式即可。',
            ],
            callout: {
              tone: 'tip',
              title: '让成品一次到位的实用写法',
              body: '写清楚「基于什么资料 + 给谁看 + 要什么文件格式 + 重点包含哪几块」。例如：“根据这两张 10 月明细表，给部门负责人写一份 2 页 Word 月报，重点列出环比下降超过 10% 的渠道。”',
            },
          },
        ],
      },
      {
        slug: 'api-key-setup',
        groupId: 'getting-started',
        title: '接入模型密钥（DeepSeek / Kimi / GLM）',
        summary: '无需注册 EvoWork 账号，按步骤获取一把 API Key 并填入「设置 → 模型」。',
        readingTime: '约 4 分钟',
        sections: [
          {
            id: 'why-byok',
            heading: '为什么直接填模型密钥就能用？',
            paragraphs: [
              'EvoWork 采用 BYOK（自带密钥）优先设计：你的请求直接发往你选择的模型服务商，费用按实际用量向模型商结算，不经过 EvoWork 账号强绑定。密钥使用操作系统钥匙串加密保存在本机，界面只显示最后四位。',
            ],
          },
          {
            id: 'deepseek-steps',
            heading: '以 DeepSeek 为例：4 步拿到并填入密钥',
            paragraphs: [
              '日常办公、需要看懂截图或扫描件时，推荐选用支持图像理解的 deepseek-flash；复杂深度推理与长文档撰写可选用 deepseek-v4-pro。',
            ],
            bullets: [
              '第 1 步：浏览器打开 platform.deepseek.com，用手机号验证码或微信扫码登录。',
              '第 2 步：在左侧「用量信息」确认账户有余额（API 费用与网页版免费对话独立，可用微信/支付宝按需少量充值）。',
              '第 3 步：点击左侧「API keys」→「创建 API key」，立即复制保存（密钥只在创建时显示全文）。',
              '第 4 步：打开 EvoWork「设置 → 模型」，选择 DeepSeek（Base URL 为 https://api.deepseek.com），粘贴密钥并测试通过即可。',
            ],
            code: 'Base URL: https://api.deepseek.com\n推荐模型: deepseek-flash（支持读图与工具调用） / deepseek-v4-pro',
          },
          {
            id: 'other-models',
            heading: 'Kimi、GLM 与其他 OpenAI 兼容服务',
            paragraphs: [
              'EvoWork 内置了对 Kimi（Moonshot，如 K3.1 Pro）、GLM（智谱，如 GLM 5.3）以及小米 MiMo 等国产模型的协议适配，也支持任意标准 OpenAI 兼容端点。在「设置 → 模型」中可以同时保存多把密钥，随时按任务切换。',
            ],
            callout: {
              tone: 'warn',
              title: '保护好你的 API Key',
              body: '不要把 API Key 发给他人或粘贴进公开文档。如怀疑泄露，请立即到模型开放平台删除旧 Key 并重新生成。',
            },
          },
        ],
      },
      {
        slug: 'office-deliverables',
        groupId: 'office',
        title: 'Word、Excel、PPT 办公成品指南',
        summary: '如何获得排版整齐、公式准确、中文图表无乱码的高质量交付物。',
        readingTime: '约 4 分钟',
        sections: [
          {
            id: 'word-pdf',
            heading: 'Word 文档与 PDF 导出',
            paragraphs: [
              'EvoWork 默认采用 A4 纸张与内置中文字体生成 .docx，内置排版规范与页数预算提醒，适合周报、方案、制度文档、会议纪要和调研报告。生成完成后，可以直接要求“同时导出 PDF”，或在右侧结果栏用本机默认应用打开。',
            ],
          },
          {
            id: 'excel-charts',
            heading: 'Excel 表格与数据图表',
            paragraphs: [
              '处理多表合并、费用核对和经营分析时，EvoWork 会先核对原始表头字段，优先写入可复算的 Excel 公式，并对汇总数与原始明细做独立勾稽验证。生成统计图表时直接使用随包中文字体，彻底告别中文变成方框的问题。',
            ],
          },
          {
            id: 'ppt-slides',
            heading: '可编辑 PPT 演示文稿',
            paragraphs: [
              '告诉 EvoWork 页数范围、汇报对象和核心论点（最好直接附带文字稿或数据表），它会自动拆分页结构并生成原生可编辑的 .pptx。拿回去后可以像同事做的 PPT 一样自由改字、换配图或套用公司母版。',
            ],
            callout: {
              tone: 'info',
              title: '关于成品质量与模型选择',
              body: '复杂 10 页以上 PPT 或多口径财务表格的质量与所选模型推理能力直接相关。遇到复杂排版或深度汇总时，建议使用旗舰档模型以获得更稳定的交付效果。',
            },
          },
        ],
      },
      {
        slug: 'library-and-ocr',
        groupId: 'office',
        title: '本地资料库、截图粘贴与扫描件 OCR',
        summary: '不上传网盘，让 EvoWork 直接读懂你电脑上的文档、表格、压缩包和扫描件。',
        readingTime: '约 3 分钟',
        sections: [
          {
            id: 'supported-files',
            heading: '支持哪些文件？',
            paragraphs: [
              '你可以直接拖入文件、点击上传，或在应用任意位置直接按 ⌘V / Ctrl+V 粘贴剪贴板截图（即使光标没点进输入框也能贴进当前草稿）。',
            ],
            bullets: [
              '文档与演示：PDF、Word（.docx）、PPT（.pptx）、Markdown、TXT、RTF',
              '数据与表格：Excel（.xlsx）、CSV、TSV',
              '图片与压缩包：JPG / PNG / GIF / BMP、ZIP / RAR 压缩包以及常见代码文件',
            ],
          },
          {
            id: 'local-ocr',
            heading: '扫描件与本地资料库检索',
            paragraphs: [
              '扫描版 PDF 和合同照片通过本机 OCR 引擎识别文字，原始文件始终保留在你的电脑里。把常用资料放进资料库后，可以在输入框里敲 @ 按文件名或正文内容快速引用。',
            ],
          },
        ],
      },
      {
        slug: 'automations-and-goals',
        groupId: 'workflow',
        title: '定时任务、/goal 预算控制与会话提炼技能',
        summary: '让重复工作自动跑起来，让长任务不失控，把好经验沉淀成一键复用的技能。',
        readingTime: '约 4 分钟',
        sections: [
          {
            id: 'automations',
            heading: '定时自动任务（Automations）',
            paragraphs: [
              '你可以用平实的中文告诉 EvoWork 周期任务，比如“每周一早上 9 点汇总上周项目笔记并生成周报”。支持设定生效起止时间、随时暂停/恢复；如果连续失败 3 次，系统会自动暂停并提醒你，绝不在后台反复空跑消耗额度。',
            ],
          },
          {
            id: 'goal-budget',
            heading: '用 /goal 控制长任务进度与预算',
            paragraphs: [
              '面对需要跑很多步的大型调研或批量文件处理，在输入框行首输入 /goal 可以设定持续目标和用量预算上限。任务支持随时暂停与断点续跑；一旦达到预算上限，EvoWork 会立即停止当前回合并清理后台命令。',
            ],
            code: '/goal 完成 10 份 PDF 标书的参数抽取与汇总表，预算用完即停',
          },
          {
            id: 'session-to-skill',
            heading: '从一次成功会话提炼专属技能',
            paragraphs: [
              '当你调顺了一套特别好用的汇报结构或对账流程，可以在任务菜单或直接用自然语言要求“把刚才的流程提炼成技能”。审阅草稿后即可保存到当前项目或全局；下次在输入框行首敲 / 就能直接调用。',
            ],
          },
        ],
      },
      {
        slug: 'security-and-boundaries',
        groupId: 'security',
        title: '安全机制、权限档位与当前边界',
        summary: '透明列出 EvoWork 的本地隐私承诺、审批规则，以及目前还做不到的事项。',
        readingTime: '约 3 分钟',
        sections: [
          {
            id: 'privacy-statement',
            heading: '数据去哪了？',
            paragraphs: [
              '文件解析、扫描件 OCR、命令执行和定时任务全部在本机完成，文档解析不会把你的原始文件传到云端。',
              '模型调用需要联网：你的提问和相关上下文会发给你自行选择的模型服务商；EvoWork 的本机网关不保存这些内容。',
            ],
          },
          {
            id: 'approval-tiers',
            heading: '三档权限与硬拦截',
            paragraphs: [
              '默认使用「请求批准」档：编辑工作空间外的文件或联网前先问你。需要放权时可临时切换到「完全访问」（需二次确认，仅对当前任务生效）。',
            ],
            bullets: [
              '删除和覆盖已有文件前会弹窗写明具体路径，即使在「完全访问」下删除命令也会先问一次。',
              '系统目录、凭据/密钥目录和 EvoWork 自身配置受硬拦截保护，任何档位都不能绕过。',
              '「帮我批准」自动审查档目前尚未接通，界面上会置灰并标明原因。',
            ],
          },
          {
            id: 'honest-limits',
            heading: '现在还做不到的（持续推进中）',
            paragraphs: ['我们相信坦诚边界比过度承诺更能建立长期信任。当前版本已知限制包括：'],
            bullets: [
              '仅提供 Apple 芯片 Mac 与 Windows 64 位安装包，Intel Mac 与 Linux 尚未提供。',
              'macOS 安装包暂未接入 Apple 公证签名，首次打开需执行一次 xattr 命令。',
              '操作电脑上的其他应用（Computer Use）仍为实验功能，仅在 macOS 上验证。',
            ],
          },
        ],
      },
      {
        slug: 'developers-open-source',
        groupId: 'developers',
        title: '本地构建、开源许可与参与贡献',
        summary: '面向开发者的技术栈概览、验收口径与源码参与入口。',
        readingTime: '约 3 分钟',
        sections: [
          {
            id: 'stack',
            heading: '技术架构与开源许可',
            paragraphs: [
              '桌面端采用 Electron + React + TypeScript，本机服务层基于 Node.js，本机模型网关负责统一适配国内外多家模型协议。本仓库代码采用 MIT 许可发布；执行内核基于开源内核（Apache-2.0），以受控小补丁方式演进。',
            ],
            code: 'pnpm install\npnpm run check   # 格式 · lint · 类型 · 测试 · 补丁预算 · 协议 · 许可清单\npnpm run build',
          },
          {
            id: 'contribute',
            heading: '反馈问题与自定义扩展',
            paragraphs: [
              '欢迎在 GitHub 提交 Issue 反馈使用问题或安全疑虑，也可以编写自定义 SKILL.md 技能包或标准 MCP 连接器扩展 EvoWork 能力。',
            ],
          },
        ],
      },
    ],
  },
  enterprise: {
    eyebrow: 'EvoWork Enterprise · 企业级安全治理',
    title: '把可控的 AI 办公助手，安全引入你的团队',
    subtitle:
      '文件保留在员工电脑本地处理，身份认证、模型额度、安全策略包与合规审计由企业集中治理——让业务提效，同时让信息安全团队放心放权。',
    primaryCta: '预约产品演示与咨询',
    secondaryCta: '查看安全与治理机制',
    modesTitle: '按你的安全要求选择部署形态',
    modesSubtitle: '复用同一套桌面端与治理协议，不强迫数据上公有云。',
    modes: [
      {
        id: 'cloud',
        badge: '快速启用',
        title: '公有云组织托管',
        summary: '开箱使用 EvoWork 托管账号、统一模型网关与配额管理，小团队当天即可全员落地。',
        points: [
          '管理员统一配置默认模型与成员额度，员工无需各自申请 API Key',
          '文档解析与本地任务仍在员工电脑运行，不强制同步完整文件上云',
          '支持用量预警、成员邀请与设备一键吊销',
        ],
      },
      {
        id: 'private',
        badge: '企业首选',
        title: '企业内网私有部署',
        summary: '将身份服务、企业模型网关、策略分发与审计中心部署在自有服务器或内网 VPC。',
        points: [
          '出口策略完全可控，可对接企业自建大模型或获准的外部商业接口',
          '通过签名策略包统一管控允许使用的模型、应用开关与风险拦截规则',
          '人员离职或设备遗失时集中收回访问权限与刷新令牌',
        ],
      },
      {
        id: 'airgapped',
        badge: '专项交付',
        title: '完全断网离线形态',
        summary: '面向高密级行业，全部客户端包、办公运行时、插件源与推理模型均位于企业内网。',
        points: [
          '关闭所有公网外部依赖，故障时绝不静默回退公网',
          '桌面安装包内置离线办公运行时与签名内网插件源',
          '按客户内网环境提供专项验收与交付支持',
        ],
      },
    ],
    governanceTitle: '管理与内容天然隔离',
    governanceSubtitle: '从数据结构层面保证管理员能管住权限和成本，同时不窥探员工本机敏感原文。',
    governanceCards: [
      {
        title: '管理端不接触任务正文',
        description:
          '租户管理后台仅管理成员、模型配置、配额与策略包，API 与数据库结构中不存储员工本机任务内容与文件原文。',
      },
      {
        title: '签名策略包与生效可视化',
        description:
          '策略变更经签名下发，支持签发前 Diff 预览、查看各设备生效面、历史版本追溯与随时撤销。',
      },
      {
        title: '设备吊销与审计导出',
        description:
          '支持按成员查看登录设备、单设备或一键吊销其他全部设备，并一键导出身份与管理审计 CSV。',
      },
    ],
    statusTitle: '企业能力当前交付透明度',
    statusSubtitle: '延续 EvoWork 坦诚原则，清楚标明「当前已落地」与「按阶段规划/内测中」的模块。',
    statusColumns: ['能力项', '当前状态', '说明'],
    statusRows: [
      {
        capability: '账号登录、邮件验证与 PKCE 令牌自动续期',
        status: 'ready',
        statusLabel: '已落地',
        detail: '已支持 HTTPS 线上部署、系统钥匙串安全存储与无感刷新。',
      },
      {
        capability: '租户管理端（成员邀请 / 额度 / 默认模型 / 策略包 / CSV 审计）',
        status: 'ready',
        statusLabel: '已落地',
        detail: '独立 Web 管理端（account.nucleant.cn），与客户端内容面严格隔离。',
      },
      {
        capability: '签名插件源与离线办公运行时分发',
        status: 'ready',
        statusLabel: '已落地',
        detail: '支持 Ed25519 签名索引校验、有效期检查与随包离线办公环境。',
      },
      {
        capability: '企业 SSO（OIDC/SAML）与部门组织架构同步',
        status: 'planned',
        statusLabel: '规划 / 内测对接',
        detail: '已形成完整企业设计方案，可按试点企业 IdP 环境联合对接。',
      },
      {
        capability: '部门共享记忆与跨端任务状态协作',
        status: 'planned',
        statusLabel: '规划 / 阶段开放',
        detail: '按项目/部门权限审核发布共享经验，不自动上传员工本机自动记忆。',
      },
    ],
    booking: {
      title: '预约演示或咨询私有化部署',
      subtitle:
        '留下你的联系方式与业务场景，我们将在 1–2 个工作日内与你联系，安排 1 对 1 演示与架构答疑。',
      expectationsTitle: '预约沟通中你可以获得',
      expectations: [
        '针对你所在团队（法务、财务、运营、研发等）的真实文档交付现场演示',
        '本机隐私边界、出口策略与私有化部署资源评估',
        '内测版企业管理端与模型网关试跑协助',
      ],
      directEmailLabel: '不想填表？也可以直接发邮件至',
      form: {
        nameLabel: '你的姓名',
        namePlaceholder: '例如：林明',
        emailLabel: '工作邮箱',
        emailPlaceholder: 'name@company.com',
        companyLabel: '公司或团队名称',
        companyPlaceholder: '例如：星河科技有限公司',
        teamSizeLabel: '预计使用规模',
        teamSizeOptions: ['10 人以下', '10 – 50 人', '50 – 200 人', '200 人以上'],
        interestsLabel: '你最关注的方向（可多选）',
        interestOptions: [
          '团队统一试用与配额管理',
          '企业内网私有化部署',
          '对接自有大模型 / 内部技能',
          '安全架构与合规评估',
        ],
        notesLabel: '补充场景说明（选填）',
        notesPlaceholder:
          '例如：我们法务和财务团队希望在本机处理合同与月报，想了解内网接入内部模型的方式…',
        consentText: '我同意 EvoWork 团队使用上述信息就本次预约与我联系。',
        submitLabel: '提交预约申请',
        submittingLabel: '正在提交…',
        previewModeNote: '当前站点未配置在线线索接口，提交后将展示演示回执并可一键通过邮件发送。',
        validationName: '请填写你的姓名',
        validationEmail: '请填写有效的工作邮箱地址',
        validationCompany: '请填写公司或团队名称',
        validationConsent: '请先勾选联系授权说明',
        successTitle: '预约信息已收到',
        successBody:
          '感谢你的联系！我们已收到你的预约申请，将在 1–2 个工作日内通过工作邮箱回复你。',
        successPreviewBody:
          '当前为无后端预览模式，你的表单已通过校验。正式上线时配置 VITE_LEAD_ENDPOINT 即可直连 Webhook 或线索接口；现在也可以点击下方按钮直接发邮件给我们。',
        successReset: '提交另一条咨询',
        successDownloadCta: '先下载个人版免费体验',
        errorTitle: '提交暂时没有成功',
        errorFallback: '你的填写内容已保留，请稍后重试，或直接发邮件至',
      },
    },
  },
  footer: {
    copyright: '© 2026 EvoWork',
    licenseNote: '应用代码以 MIT 许可开源 · 文件本机优先处理',
    links: [
      { label: '下载上手', page: 'download' },
      { label: '文档中心', page: 'docs', docSlug: 'quick-start' },
      { label: '安全与隐私', page: 'docs', docSlug: 'security-and-boundaries' },
      { label: '企业版', page: 'enterprise' },
      { label: '账号登录', href: SITE_CONFIG.links.accountPortal, external: true },
      { label: 'GitHub', href: SITE_CONFIG.links.github, external: true },
    ],
  },
};
