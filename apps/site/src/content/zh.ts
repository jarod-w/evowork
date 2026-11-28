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
      download: '下载 — EvoWork',
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
    backToTop: '返回顶部',
  },
  nav: {
    items: [
      { page: 'home', label: '首页' },
      { page: 'download', label: '下载' },
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
    eyebrow: 'EvoWork · 桌面端 AI 办公工作台',
    headline: '一句话交代工作，拿回能直接用的文件',
    subheadline:
      '把周报、合同、数据表格、行业调研和季度汇报交给装在电脑里的 AI 办公助手。它会自动规划、本机解析资料并核对结果，直接交付排版好的 Word、Excel 和 PPT 成品。',
    primaryCta: {
      macos: '免费下载 macOS 版',
      windows: '免费下载 Windows 版',
    },
    secondaryCta: '3 分钟上手指南',
    trustStrip: [
      '文件留在本机处理',
      '无需注册账号即可使用',
      '打开就能生成 Word / Excel / PPT',
      '高危操作先问你再执行',
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
          { text: '生成带清晰图表的 8 页可编辑 PPTX 与汇总表', status: 'done' },
        ],
        deliverableName: '10月销售复盘汇总.xlsx + 季度复盘.pptx',
        deliverableKind: 'xlsx',
        deliverableBadge: '成品已生成 · 可直接打开',
        previewHeading: '2026 年 10 月区域销售达成汇总',
        previewSubheading: '公式已回写校验 · 图表清晰无乱码 · 版式整齐可直接汇报',
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
        modelTag: '本机文字识别 + 智能审查',
        steps: [
          { text: '本机识别 26 页扫描 PDF 内容，原文未上传云端', status: 'done' },
          { text: '比对常见商务风控条款，定位 4 处高风险约定', status: 'done' },
          { text: '输出 A4 排版 Word 审查意见表（含原页码与修改建议）', status: 'done' },
        ],
        deliverableName: '供应商框架协议_风险审查表.docx',
        deliverableKind: 'docx',
        deliverableBadge: 'A4 成品 · 已标注页码',
        previewHeading: '合同核心风险点与修改建议',
        previewSubheading: '本机识别扫描件 · 标注原合同页码 · 可直接发给法务/业务复核',
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
    proSkillsSection: {
      title: '专业技能，让复杂工作更简单',
      subtitle:
        '针对不同专业领域，EvoWork 会自动调用对应技能，按专业流程分析信息，直接交付拿来就能用的工作成果。',
      badge: '领域专业技能',
      items: [
        {
          id: 'finance-hotspots',
          domain: '金融行业',
          name: '市场热点分析',
          summary: '聚合政策动向、行业公告与核心数据变化，快速拆解板块逻辑、资金主线与风险提示。',
          deliverableTag: '热点简报 · .docx',
          prompt:
            '梳理近两周新能源与算力产业链的关键公告与市场热点，按事件催化、核心标的逻辑和风险提示输出一份研究简报。',
          outputTitle: '周度市场热点与行业催化分析简报.docx',
          outputHighlights: [
            '按政策催化、业绩验证与情绪面分层梳理主线，结论清晰直给',
            '自动整理关键指标对比表，并标注每条公开信息来源出处',
            '直接输出规范排版 Word 简报，方便晨会分享与投研留档',
          ],
          outputMetrics: [
            { label: '追踪维度', value: '政策 · 业绩 · 资金' },
            { label: '信息溯源', value: '逐条附出处' },
            { label: '交付形式', value: 'Word / PDF 简报' },
          ],
        },
        {
          id: 'academic-reading',
          domain: '学术研究',
          name: '文献精读',
          summary: '本机解析多篇中英文 PDF 论文，提炼研究问题、实验设计、核心结论与方法局限。',
          deliverableTag: '文献综述 · .docx',
          prompt:
            '精读文件夹里的 8 篇领域顶会 PDF，按研究假设、数据集、核心结论与局限性整理对比表，并汇总标准参考文献格式。',
          outputTitle: '8篇核心论文精读笔记与方法对比表.docx',
          outputHighlights: [
            '逐篇抽取研究背景、方法创新、实验指标与作者自述局限',
            '横向生成多篇文献对比矩阵，快速定位研究空白与切入点',
            '自动整理规范引文目录，大幅节省写综述与组会汇报时间',
          ],
          outputMetrics: [
            { label: '批量精读', value: '多篇 PDF 同屏对比' },
            { label: '核心结构', value: '方法 · 结论 · 局限' },
            { label: '引用整理', value: '自动生成文献清单' },
          ],
        },
        {
          id: 'legal-contract',
          domain: '法务商务',
          name: '合同风险审查',
          summary: '识别扫描件与电子版协议，逐条核对付款、交付、违约与保密条款，给出落地修订意见。',
          deliverableTag: '审查意见表 · .docx',
          prompt:
            '对照标准采购风控清单审查这份年度合作协议，列出高/中风险条款、对应原页码和可直接替换的修改措辞。',
          outputTitle: '年度合作协议_风险点与修订建议.docx',
          outputHighlights: [
            '扫描件直接在本机识别，敏感合同原文不上传给第三方网盘',
            '按高/中/低风险分级标注，直接给出可直接套用的修改建议',
            '保留原文件页码与条款编号，便于法务和业务团队快速复核',
          ],
          outputMetrics: [
            { label: '文件兼容', value: 'Word / PDF / 扫描件' },
            { label: '风险分级', value: '高 · 中 · 低清晰标示' },
            { label: '隐私边界', value: '原件留在本机' },
          ],
        },
        {
          id: 'ops-analytics',
          domain: '经营分析',
          name: '财务与业务报表分析',
          summary: '合并多部门明细表，自动核对数据口径与异常波动，同步产出带公式总表与汇报图表。',
          deliverableTag: '分析表 + 图表 · .xlsx',
          prompt:
            '合并 4 个区域的季度经营台账，计算各产品线毛利率与同比变化，标出异常波动项并生成可视化图表。',
          outputTitle: '季度经营分析与异常波动台账.xlsx',
          outputHighlights: [
            '自动映射不同部门的杂乱表头，汇总数与明细行逐项核对',
            '写入可复算的真实 Excel 公式，拿回去改一个数整表联动更新',
            '自带清晰中文统计图表，直接复制进汇报材料即可使用',
          ],
          outputMetrics: [
            { label: '公式核对', value: '真实可编辑公式' },
            { label: '异常定位', value: '自动高亮波动项' },
            { label: '图表输出', value: '高清中文图表' },
          ],
        },
      ],
    },
    deliverySection: {
      title: '从复杂任务，到持续交付',
      subtitle: '深入研究、生成专业工作成果，并让重复工作自动完成。',
      items: [
        {
          id: 'office',
          icon: 'slides',
          label: 'Office 工具',
          description: '生成专业的 PPT、Word 文档和 Excel 表格，版式整洁、公式准确，加速成果交付。',
          deliverableTag: 'PPT · Word · Excel',
          stageTitle: '一步到位交付可编辑 PPT、文档与表格',
          stagePrompt:
            '根据这 3 份月度业务数据和调研笔记，整理一份汇总 Excel，再生成一份 10 页管理层汇报 PPT 和配套 Word 摘要。',
          stageHighlight: '原生可编辑文件 · 默认规范版式 · 中文图表清晰不乱码',
          stageBullets: [
            'Word 报告：默认 A4 排版、标题目录层级分明，支持一键导出 PDF',
            'Excel 表格：写入真实可编辑公式，自动核对明细与汇总勾稽关系',
            'PPT 演示：每页文字、卡片与图表均为标准可编辑元素，减少溢出与拥挤',
          ],
          stageFooterNote: '下载装好就能直接生成成品，无需手动拷贝聊天文本二次排版',
        },
        {
          id: 'research',
          icon: 'library',
          label: '深入调研分析',
          description: '深度分析复杂问题，检索多方相关信息并标明出处，生成结构完整的专业研究报告。',
          deliverableTag: '深度调研 · 报告',
          stageTitle: '多源信息检索 + 本地资料交叉印证',
          stagePrompt:
            '围绕“国产智能办公软件出海机会”做深度调研，结合目录里的内部访谈纪要与公开市场数据，输出一份完整行业研究报告。',
          stageHighlight: '结合本机资料与实时公开检索 · 引用网页逐条标明来源出处',
          stageBullets: [
            '自动拆解调研框架，分阶段检索政策、竞品、定价与用户反馈等多方资料',
            '把电脑里的 PDF、历史纪要与最新公开信息整合进同一份分析框架',
            '交付结论先行、带数据图表与参考来源清单的正式研究报告，便于复核',
          ],
          stageFooterNote: '长篇深度调研支持随时暂停与断点续跑，可设用量上限防止失控',
        },
        {
          id: 'schedule',
          icon: 'clock',
          label: '定时任务',
          description: '按预定时间自动执行分析、报告与汇总任务，让周报与日常监控省心运转。',
          deliverableTag: '定时自动执行',
          stageTitle: '每周一 09:00 自动汇总周报与关键指标',
          stagePrompt:
            '每周一上午 9 点扫描「本周进展」文件夹中的最新记录与数据表，自动生成团队周报草稿并提醒我审阅。',
          stageHighlight: '用自然语言约定周期 · 每次执行留存记录 · 连续失败 3 次自动暂停',
          stageBullets: [
            '支持每日、每周、每月等灵活周期，也可设定任务的起止生效时间',
            '随时一键暂停或恢复，每次定时产出都有清晰历史记录可回看',
            '遇到异常连续失败 3 次会自动暂停并提示原因，不会在后台反复空跑',
          ],
          stageFooterNote: '定时任务在本机按你授权的范围运行，既省心又可控',
        },
      ],
    },
    computerActionSection: {
      title: '操作电脑，完成复杂任务',
      subtitle:
        'EvoWork 可以读取、创建和修改电脑里的本地文件，也可以自动打开网页、填写信息和完成跨页面操作，把原本需要反复切换窗口的多步琐事一并办妥。',
      badge: '本机文件 + 自动网页操作',
      promptLabel: '一句话交代跨文件、跨网页任务',
      samplePrompt:
        '读取桌面「待报销发票」文件夹里的所有 PDF，核对金额后整理成报销明细表，并打开指定网页表单帮我预填基本信息，提交前停下来让我确认。',
      capabilities: [
        {
          id: 'local-files',
          icon: 'library',
          badge: '本地文件操作',
          title: '读取、创建与批量修改本机文件',
          description:
            '直接在你授权的文件夹内解析文档、整理归档、批量重命名、转换格式并回写结果文件。',
          sampleSteps: [
            '读取 PDF、Word、Excel、PPT、压缩包与扫描件',
            '按规则批量重命名文件、归类目录并生成台账',
            '覆盖或删除已有文件前先弹窗写清路径，征得你同意',
          ],
        },
        {
          id: 'web-automation',
          icon: 'globe',
          badge: '自动网页操作',
          title: '自动打开网页、填写信息与跨页面流转',
          description:
            '配合内置浏览器与桌面操作能力，自动打开目标网页查询信息、录入表单并串起跨页面流程。',
          sampleSteps: [
            '自动打开多个参考页面采集公开信息并摘录要点',
            '根据本地表格自动填写网页表单字段，减少手工复制粘贴',
            '遇到登录、最终提交或敏感动作自动停下，交给你亲自确认',
          ],
        },
        {
          id: 'safe-handover',
          icon: 'shield',
          badge: '全程可见可控',
          title: '每一步看得见，随时可以暂停和接管',
          description: '操作进度实时展开，只触碰你授权的范围，系统敏感目录与关键凭据默认受保护。',
          sampleSteps: [
            '默认「请求批准」模式，跨目录修改或联网前先询问',
            '执行过程中随时可一键停止或补充新的要求',
            '把跑顺的复杂步骤一键保存为技能，下次直接复用',
          ],
        },
      ],
      footerNote:
        '跨应用桌面操控目前在 macOS 上作为实验功能提供，有风险的操作会在执行前先向你确认。',
    },
    zeroBarrierSection: {
      title: '三步上手，接上你的模型就能用',
      subtitle:
        '不用折腾复杂安装步骤，也不用注册 EvoWork 账号。下载打开、填一把模型密钥，三分钟开始干活。',
      badge: '零门槛上手',
      steps: [
        {
          num: '01',
          title: '下载即进入主界面',
          desc: '打开应用直接开始使用，没有冗长的注册流程和复杂初始化设置。',
        },
        {
          num: '02',
          title: '填入你常用的模型密钥',
          desc: '支持 DeepSeek、Kimi（Moonshot）、GLM（智谱）等主流模型服务，随时自由切换。',
        },
        {
          num: '03',
          title: '拖入资料，说一句话发送',
          desc: '右侧实时查看进度与成品文件，满意后直接用本机软件打开或发送给同事。',
        },
      ],
      providersLabel: '支持主流模型服务自由接入',
      providers: [
        { name: 'DeepSeek', note: 'V4 Pro / Flash · 图文教程完备' },
        { name: 'Kimi (Moonshot)', note: 'K3.1 Pro · 长文档阅读友好' },
        { name: 'GLM (智谱)', note: 'GLM 5.3 · 办公表格表现稳定' },
        { name: '其他兼容服务', note: '支持自定义地址灵活接入' },
      ],
      guideLinkLabel: '查看 DeepSeek 密钥获取图文教程',
      noAccountNote: '你的模型密钥加密保存在本机系统钥匙串中，界面仅显示后四位，绝不上传。',
    },
    trustSection: {
      title: '放心交给它：你的文件始终在你的电脑里',
      subtitle: '动文件前先问你，数据去哪一眼看清——应用内外的隐私承诺完全一致。',
      localTitle: '全部留在你的电脑上',
      localBadge: '本机完成 · 不传原文',
      localItems: [
        'PDF、Word、Excel、PPT、压缩包解析与扫描件识别全在本机运行',
        '文件读写、整理汇总与定时任务都在你授权的本机目录内完成',
        '模型密钥加密保存在系统钥匙串中，界面只显示后四位',
        '系统敏感目录与关键凭据自动受保护，不可越权访问',
      ],
      networkTitle: '需要联网时，去向透明',
      networkBadge: '按需发往你选的模型商',
      networkItems: [
        '只有提问与相关上下文发往你自己选择的模型服务商，不额外留存原文',
        '联网查资料时自动列出引用网页出处，方便人工核对',
        '安装新技能前会先明示要执行的动作与需要访问的网址，确认后才启用',
        '做不到就直说：遇到模型看不了图或暂不支持的场景会明确提示，不悄悄糊弄',
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
          description: '开启前需二次确认，仅限当前任务。即使在此档位，删除文件前仍会先问你一次。',
        },
        {
          name: '帮我批准',
          badge: '规划中 · 尚未开启',
          tone: 'muted',
          description: '按风险自动审查并只拦截高危动作。这一档目前尚未开启，应用内会清晰标明。',
        },
      ],
      guardrails: [
        '删除或覆盖已有文件前明确提示具体文件路径',
        '你点击拒绝后，不会偷偷换其他方式绕过执行',
        '全程步骤可展开追溯，结果由你最终把关',
      ],
    },
    promptSection: {
      title: '复制一句话，立即体验职场高频场景',
      subtitle: '点击任意卡片即可复制提示词，打开 EvoWork 粘贴发送就能试用。',
      clickHint: '点击复制',
      rows: [
        [
          {
            id: 'p-finance',
            category: '金融行业',
            title: '市场热点与板块分析',
            formatTag: '.docx',
            prompt:
              '梳理本周重点行业政策与市场热点动态，整理核心逻辑、数据对比和风险提示，输出一份可直接晨会分享的 Word 简报。',
          },
          {
            id: 'p-academic',
            category: '学术研究',
            title: '多篇 PDF 文献精读对比',
            formatTag: '.docx',
            prompt:
              '精读文件夹里的 5 篇论文 PDF，按研究问题、方法创新、实验结论和局限性整理对比表，并附规范参考文献列表。',
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
            id: 'p-contract',
            category: '法务商务',
            title: '扫描合同风险点审查',
            formatTag: '.docx',
            prompt:
              '本机识别这份扫描版供应商合同，把付款条件、违约责任、知识产权和自动续约风险整理成 Word 审查表并标注页码。',
          },
        ],
        [
          {
            id: 'p-research',
            category: '深度调研',
            title: '多源信息竞品研究报告',
            formatTag: '.docx',
            prompt:
              '深度调研国内外 5 款主流办公协作产品的定价与核心能力，结合本地访谈记录整理一份带出处的专业研究报告 Word。',
          },
          {
            id: 'p-batch',
            category: '操作电脑',
            title: '批量发票整理与网页预填',
            formatTag: '文件 + 网页',
            prompt:
              '读取「待整理发票」文件夹里的 PDF，按「日期_开票方_金额」列出重命名方案并生成报销台账 Excel，等我确认后继续下一步。',
          },
          {
            id: 'p-schedule',
            category: '定时任务',
            title: '每周定时简报与汇总',
            formatTag: '定时任务',
            prompt:
              '帮我建一个定时任务：每周五下午 5 点整理「项目日志」里的最新更新，输出一份本周交付清单供我审阅。',
          },
          {
            id: 'p-minutes',
            category: '会议协作',
            title: '会议纪要与待办拆解',
            formatTag: '.docx',
            prompt:
              '将这份原始会议速记整理成规范会议纪要，单独抽出「决议事项」和「责任人 + 截止时间」行动清单表。',
          },
          {
            id: 'p-email',
            category: '客户沟通',
            title: '英文商务邮件与报价单',
            formatTag: '.pdf',
            prompt:
              '把这份中文产品报价说明改写成得体的英文商务回复邮件，并附一份排版干净的英文 PDF 报价单。',
          },
        ],
      ],
    },
    bottomCta: {
      title: '把繁琐的文档整理与重复流程，交给 EvoWork',
      subtitle: '免费下载桌面版，无需注册账号，3 分钟接上你的模型开始交付专业成品。',
      primaryLabel: '前往下载页面',
      secondaryLabel: '咨询企业版 / 预约演示',
    },
  },
  download: {
    eyebrow: 'EvoWork · 桌面客户端',
    title: '下载 EvoWork，3 分钟开始第一次交付',
    subtitle: '打开就能直接生成排版整齐的 Word、Excel 与 PPT，无需注册账号或折腾额外配置。',
    detectedLabel: '已为你推荐当前系统',
    downloadButton: '立即下载',
    requirementsLabel: '系统要求',
    checksumLabel: '安装说明',
    unavailableNotice:
      '说明：当前提供 Apple 芯片（M1–M4）macOS 与 Windows（64 位）安装包，Intel Mac 与 Linux 版本暂未提供。',
    platforms: [
      {
        id: 'macos',
        name: 'macOS（Apple 芯片）',
        arch: 'Apple Silicon · DMG 安装包',
        badge: 'Apple Silicon (M 系列)',
        fileName: 'EvoWork-mac-arm64.dmg',
        sizeText: '约 295 MB（安装后即开即用）',
        requirements: 'macOS 13 及以上 · Apple M1 / M2 / M3 / M4',
        url: SITE_CONFIG.links.macArm64Dmg,
        sha256Hint: '首次打开若提示未签名，请按下方一行指引放行即可',
        highlights: [
          '拖入「应用程序」即可使用，无需额外安装办公插件',
          '支持本机文档解析、扫描件识别与跨应用操作',
          '设置内一键检查更新，旧版本不会强制失效',
        ],
      },
      {
        id: 'windows',
        name: 'Windows（64 位）',
        arch: '64 位 · 向导安装程序',
        badge: 'Windows 10 / 11',
        fileName: 'EvoWork-win-x64-setup.exe',
        sizeText: '向导式安装包（支持自定义安装目录）',
        requirements: 'Windows 10 / 11（64 位）',
        url: SITE_CONFIG.links.windowsSetupExe,
        sha256Hint: '支持选择安装路径、创建快捷方式与应用内自动升级',
        highlights: [
          '向导式安装体验，可自选安装目录与桌面快捷方式',
          '后续新版本支持应用内一键升级并自动重新打开',
          '打开就能直接制作 Word、Excel、PPT 成品，零额外配置',
        ],
      },
    ],
    unsignedGuide: {
      badge: 'macOS 首次打开必看（临时指引）',
      title: '如果 macOS 提示「已损坏，无法打开」怎么办？',
      subtitle:
        '安装包本身完全正常。因为现阶段尚未接入 Apple 正式公证签名，macOS 会拦截首次打开；在「终端」粘贴运行下面这一行即可正常使用（完成正式签名后将取消这一步）。',
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
      title: '遇到系统安全提示时点击「更多信息 → 仍要运行」',
      body: '双击安装向导后可自由选择安装目录和快捷方式。后续发布新版本时，可直接在「设置 → 关于与更新」里静默升级并自动重启。',
    },
    quickStartTitle: '装好之后，3 步完成第一个任务',
    quickStartSubtitle: '不需要注册 EvoWork 账号，也不需要复杂的初始化配置。',
    quickStartSteps: [
      {
        number: '01',
        title: '打开 EvoWork，直接进入工作台',
        description:
          '首次打开无冗长引导，直接看到主界面。任务文件默认保存在独立目录中，可在「设置 → 常规」随时更改保存位置。',
      },
      {
        number: '02',
        title: '在「设置 → 模型」添加一把模型密钥',
        description:
          '任选你已有余额的 DeepSeek、Kimi（Moonshot）、GLM（智谱）或兼容服务填入即可。密钥会加密保存在本机系统钥匙串里。',
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
          label: '查看更多办公成品与使用技巧',
          page: 'docs',
          docSlug: 'office-deliverables',
        },
      },
    ],
  },
  docs: {
    title: '文档中心',
    subtitle:
      '写给职场用户的清晰使用手册：从 3 分钟接入模型、产出专业办公成品，到看懂每一项安全边界。',
    searchPlaceholder: '搜索文档标题或关键词（如 DeepSeek、PPT、定时任务、隐私）…',
    emptySearch: '没有找到匹配的文档，试试换个关键词，如「密钥」「Word」「隐私」。',
    onThisPage: '本页目录',
    previousLabel: '上一篇',
    nextLabel: '下一篇',
    groups: [
      { id: 'getting-started', label: '快速开始' },
      { id: 'office', label: '高频办公指南' },
      { id: 'workflow', label: '专业技能与自动化' },
      { id: 'security', label: '安全、隐私与边界' },
    ],
    articles: [
      {
        slug: 'quick-start',
        groupId: 'getting-started',
        title: '3 分钟安装与首次使用',
        summary: '从下载安装包到交付第一份 Word/Excel/PPT 成品的完整步骤。',
        readingTime: '约 3 分钟',
        sections: [
          {
            id: 'install',
            heading: '1. 安装桌面应用',
            paragraphs: [
              '前往下载页获取对应系统的安装包。EvoWork 安装完成后即可直接生成排版整齐的 Word、Excel 和 PPT 文件，不需要你手动配置任何额外环境。',
            ],
            bullets: [
              'macOS（Apple 芯片）：拖进「应用程序」后，如当前版本提示未签名，按下载页指引在终端粘贴放行命令即可打开。',
              'Windows（64 位）：运行安装向导，选择安装目录与快捷方式，完成后直接启动。',
            ],
          },
          {
            id: 'first-launch',
            heading: '2. 首次启动直达工作台',
            paragraphs: [
              '打开 EvoWork 后会直接进入主界面，无需注册账号，也没有冗长的初始化引导。',
              '没有指定项目文件夹的任务会自动保存在独立目录中；你可以随时在「设置 → 常规」修改默认保存位置。',
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
        summary: '无需注册 EvoWork 账号，按步骤获取一把模型密钥并填入「设置 → 模型」。',
        readingTime: '约 4 分钟',
        sections: [
          {
            id: 'why-byok',
            heading: '为什么填一把模型密钥就能用？',
            paragraphs: [
              'EvoWork 支持直接填入你自己的模型服务密钥：费用按实际使用量直接向模型商结算，无需额外绑定平台会员。密钥加密保存在电脑的系统钥匙串中，界面只显示最后四位。',
            ],
          },
          {
            id: 'deepseek-steps',
            heading: '以 DeepSeek 为例：4 步完成配置',
            paragraphs: [
              '日常办公、需要看懂截图或扫描件时，推荐选用支持看图的 deepseek-flash；复杂深度分析与长文档撰写可选用 deepseek-v4-pro。',
            ],
            bullets: [
              '第 1 步：浏览器打开 platform.deepseek.com，用手机号验证码或微信扫码登录。',
              '第 2 步：在左侧「用量信息」确认账户有余额（可用微信/支付宝按需少量充值）。',
              '第 3 步：点击左侧「API keys」→「创建 API key」，立即复制保存（密钥只在创建时显示全文）。',
              '第 4 步：打开 EvoWork「设置 → 模型」，选择 DeepSeek，粘贴密钥并保存即可使用。',
            ],
            code: '服务地址: https://api.deepseek.com\n推荐模型: deepseek-flash（日常办公与看图） / deepseek-v4-pro（深度写作）',
          },
          {
            id: 'other-models',
            heading: 'Kimi、GLM 与其他模型服务',
            paragraphs: [
              'EvoWork 同样支持 Kimi（Moonshot）、GLM（智谱）以及各类兼容模型服务。你可以在「设置 → 模型」中同时保存多把密钥，随时按任务需要切换。',
            ],
            callout: {
              tone: 'warn',
              title: '保护好你的密钥',
              body: '不要把密钥发给他人或粘贴进公开文档。如怀疑泄露，请立即到对应模型平台删除旧密钥并重新创建。',
            },
          },
        ],
      },
      {
        slug: 'office-deliverables',
        groupId: 'office',
        title: 'Office 工具：Word、Excel、PPT 成品指南',
        summary: '如何获得排版整齐、公式准确、图表清晰的高质量交付物。',
        readingTime: '约 4 分钟',
        sections: [
          {
            id: 'word-pdf',
            heading: 'Word 文档与 PDF 导出',
            paragraphs: [
              'EvoWork 默认采用 A4 纸张与清晰中文排版生成 Word 文档，适合周报、方案、制度文档、会议纪要和深度调研报告。生成完成后，可以直接要求“同时导出 PDF”，或在右侧结果栏用本机软件打开。',
            ],
          },
          {
            id: 'excel-charts',
            heading: 'Excel 表格与数据图表',
            paragraphs: [
              '处理多表合并、费用核对和经营分析时，EvoWork 会先核对原始表头字段，写入可复算的真实 Excel 公式，并对汇总数与原始明细做核对验证。生成的中文图表清晰可读，可直接嵌入汇报材料。',
            ],
          },
          {
            id: 'ppt-slides',
            heading: '可编辑 PPT 演示文稿',
            paragraphs: [
              '告诉 EvoWork 页数范围、汇报对象和核心论点（最好附带文字稿或数据表），它会自动拆分页结构并生成原生可编辑的 PPT。拿回去后可以像同事做的幻灯片一样自由改字、换图或套用公司模板。',
            ],
            callout: {
              tone: 'info',
              title: '关于复杂文档与模型选择',
              body: '复杂 10 页以上 PPT 或多口径财务表格的最终效果与所选模型推理能力相关。遇到复杂汇报或深度分析时，建议使用旗舰档模型以获得更稳定的交付质量。',
            },
          },
        ],
      },
      {
        slug: 'library-and-ocr',
        groupId: 'office',
        title: '本地文件、截图粘贴与扫描件识别',
        summary: '不上传网盘，让 EvoWork 直接读懂你电脑上的文档、表格、压缩包和扫描件。',
        readingTime: '约 3 分钟',
        sections: [
          {
            id: 'supported-files',
            heading: '支持哪些文件？',
            paragraphs: [
              '你可以直接拖入文件、点击上传，或在应用窗口任意位置按 ⌘V / Ctrl+V 粘贴剪贴板截图。',
            ],
            bullets: [
              '文档与演示：PDF、Word（.docx）、PPT（.pptx）、Markdown、TXT',
              '数据与表格：Excel（.xlsx）、CSV、TSV',
              '图片与压缩包：JPG / PNG / GIF / BMP 以及 ZIP / RAR 压缩包',
            ],
          },
          {
            id: 'local-ocr',
            heading: '扫描件识别与 @ 精准引用',
            paragraphs: [
              '扫描版 PDF 和合同照片全部在本机完成文字识别，原始文件不离开电脑。把常用资料放进资料库后，可以在输入框里敲 @ 按文件名或正文内容快速引用。',
            ],
          },
        ],
      },
      {
        slug: 'automations-and-goals',
        groupId: 'workflow',
        title: '专业技能、深入调研与定时任务',
        summary: '调用领域专业技能、自动执行周期报告，并把好用的流程沉淀成专属技能。',
        readingTime: '约 4 分钟',
        sections: [
          {
            id: 'pro-skills',
            heading: '用专业技能处理金融、学术与办公任务',
            paragraphs: [
              '在输入框行首敲 / 即可快速选用专业技能，如金融市场热点分析、学术文献精读、合同审查、周报撰写与数据分析。你也可以把一次跑顺的会话一键提炼为专属技能，下次直接复用。',
            ],
          },
          {
            id: 'automations',
            heading: '定时自动任务',
            paragraphs: [
              '用平实的中文告诉 EvoWork 周期任务，比如“每周一早上 9 点汇总上周项目笔记并生成周报”。支持设定生效起止时间、随时暂停/恢复；如果连续失败 3 次会自动暂停并提醒你，绝不在后台反复空跑。',
            ],
          },
          {
            id: 'goal-budget',
            heading: '长任务进度与预算可控',
            paragraphs: [
              '面对需要跑很多步的大型调研或批量文件处理，在输入框行首输入 /goal 可以设定持续目标和用量预算上限。任务支持随时暂停与接着做；达到预算上限后会立刻停下，不超支。',
            ],
            code: '/goal 完成 10 份行业资料的深度调研与汇总报告，预算用完即停',
          },
        ],
      },
      {
        slug: 'security-and-boundaries',
        groupId: 'security',
        title: '安全机制、权限档位与当前边界',
        summary: '透明列出 EvoWork 的本地隐私承诺、审批规则，以及当前版本的适用边界。',
        readingTime: '约 3 分钟',
        sections: [
          {
            id: 'privacy-statement',
            heading: '数据去哪了？',
            paragraphs: [
              '文件解析、扫描件识别、本地整理和定时任务全部在你的电脑上完成，文档解析不会把原始文件传到云端。',
              '模型调用需要联网：你的提问和相关上下文会发给你自行选择的模型服务商，不额外留存这些内容。',
            ],
          },
          {
            id: 'approval-tiers',
            heading: '三档权限与高危确认',
            paragraphs: [
              '默认使用「请求批准」档：编辑工作空间外的文件或联网前先问你。需要放权时可临时切换到「完全访问」（需二次确认，仅对当前任务生效）。',
            ],
            bullets: [
              '删除和覆盖已有文件前会弹窗写明具体路径，即使在「完全访问」下删除操作也会先问一次。',
              '系统敏感目录与关键凭据自动受保护，任何档位都不能越权访问。',
              '「帮我批准」自动审查档目前尚未开启，应用内会置灰并标明原因。',
            ],
          },
          {
            id: 'honest-limits',
            heading: '当前适用边界说明',
            paragraphs: ['以下为当前版本的实际情况，我们持续在后续版本中完善：'],
            bullets: [
              '目前提供 Apple 芯片 Mac 与 Windows 64 位安装包，Intel Mac 与 Linux 尚未提供。',
              'macOS 安装包暂未接入正式公证签名，首次打开需按下载页指引执行一次放行操作。',
              '操作电脑上的其他应用目前在 macOS 上作为实验功能提供。',
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
      '文件保留在员工电脑本地处理，身份权限、模型额度、安全策略与合规审计由企业集中治理——让业务提效，同时让信息安全团队放心放权。',
    primaryCta: '预约产品演示与咨询',
    secondaryCta: '查看核心安全能力',
    modesTitle: '按你的安全要求选择部署形态',
    modesSubtitle: '统一桌面端与企业治理能力，不强迫敏感文档上传公有云。',
    modes: [
      {
        id: 'cloud',
        badge: '快速启用',
        title: '公有云组织托管',
        summary: '开箱使用统一组织账号、共享模型通道与配额管理，小团队当天即可全员落地。',
        points: [
          '管理员统一配置可用模型与成员额度，员工无需各自申请密钥',
          '文档解析与本地任务仍在员工电脑运行，不强制同步完整文件上云',
          '支持用量预警、成员邀请与设备一键收回访问权',
        ],
      },
      {
        id: 'private',
        badge: '企业首选',
        title: '企业内网私有部署',
        summary: '将身份管理、企业模型通道、策略分发与审计中心部署在自有服务器或内网环境。',
        points: [
          '数据出口完全可控，可对接企业自建大模型或获准的外部模型服务',
          '通过集中策略统一管控允许使用的模型、功能开关与风险拦截规则',
          '人员离职或设备遗失时集中收回访问权限与登录会话',
        ],
      },
      {
        id: 'airgapped',
        badge: '专项交付',
        title: '完全断网离线形态',
        summary: '面向高密级行业，全部客户端包、插件源与推理模型均位于企业内网。',
        points: [
          '关闭所有公网外部依赖，故障时绝不悄悄回退公网',
          '支持内网独立分发安装包与经过内部审核的技能库',
          '按客户内网环境提供专项验收与交付支持',
        ],
      },
    ],
    nextPlanTitle: '企业核心安全与审计能力',
    nextPlanSubtitle: '面向金融、法务与大型组织的合规与数据零泄露要求，原生内置两大核心能力：',
    nextPlanCards: [
      {
        id: 'audit-logs',
        badge: '核心能力 · 01',
        title: '全量操作日志与企业审计',
        summary:
          '完整保留全流程操作日志，涵盖任务发起、文件读写、网页与工具调用、审批决策及策略变更，满足企业长期留痕、责任追溯与合规审计需求。',
        flowSteps: [
          '自动记录员工与管理员关键操作轨迹，支持按部门、成员与时间检索',
          '日志支持集中归档、防篡改留存与定期导出，便于内外部审计核查',
          '异常操作与高危拦截实时留痕，帮助安全团队快速定位与复盘',
        ],
        highlight: '让每一次 AI 办公交付都有据可查、有迹可循',
      },
      {
        id: 'sensitive-masking',
        badge: '核心能力 · 02',
        title: '敏感信息检测与数据仿真脱敏',
        summary:
          '在数据发往大模型之前自动识别客户姓名、金额、合同主体、证件与账号等敏感信息，通过仿真技术替换为高保真仿真数据；模型处理完成返回后，在本机自动精准还原真实数据。',
        flowSteps: [
          '本机自动扫描文本与表格，精准识别企业自定义及通用敏感字段',
          '通过仿真技术替换为语义一致的仿真值，不向大模型暴露任何真实敏感数据',
          '大模型返回分析或文档结果后，客户端在本机无缝还原为真实业务数据',
        ],
        highlight: '大模型全程不见真实数据，员工拿到的是完整准确的真实成品',
      },
    ],
    governanceTitle: '管理与内容天然隔离',
    governanceSubtitle: '管理员既能管住权限、成本与合规边界，又不会在后台随意翻看员工本机原文件。',
    governanceCards: [
      {
        title: '管理后台与任务正文隔离',
        description:
          '企业管理端专注管理成员、模型配置、配额与安全策略，不将员工本机文档正文默认同步到管理后台。',
      },
      {
        title: '集中策略下发与变更预览',
        description:
          '安全策略统一下发至团队设备，支持下发前预览变更范围、查看生效状态、追溯历史版本与随时撤销。',
      },
      {
        title: '设备权限回收与审计导出',
        description: '支持按成员查看已登录设备、一键吊销指定或全部设备，并导出身份与管理审计报表。',
      },
    ],
    statusTitle: '企业版核心能力清单',
    statusSubtitle: '覆盖身份治理、安全脱敏、全量审计与技能分发，满足企业团队规模化落地需求。',
    statusColumns: ['能力项', '支持方式', '说明'],
    statusRows: [
      {
        capability: '全量操作日志留存与企业合规审计',
        status: 'ready',
        statusLabel: '核心支持',
        detail: '保留全流程操作日志，支持企业集中归档、检索溯源与合规审计。',
      },
      {
        capability: '敏感信息检测与仿真脱敏还原（大模型不见真实数据）',
        status: 'ready',
        statusLabel: '核心支持',
        detail: '发往大模型前自动检测并用仿真数据替换，结果返回后在本机自动还原真实数据。',
      },
      {
        capability: '企业统一账号登录、邮箱验证与安全会话续期',
        status: 'ready',
        statusLabel: '核心支持',
        detail: '支持安全加密通信、本机钥匙串凭据保护与无感续期。',
      },
      {
        capability: '租户管理后台（成员邀请 / 额度 / 默认模型 / 安全策略 / 审计导出）',
        status: 'ready',
        statusLabel: '核心支持',
        detail: '独立管理控制台，专注权限与额度治理。',
      },
      {
        capability: '企业精选技能分发与离线办公能力',
        status: 'ready',
        statusLabel: '核心支持',
        detail: '支持经过签名校验的技能目录分发与内网离线使用。',
      },
      {
        capability: '企业单点登录（SSO）与组织架构集成',
        status: 'ready',
        statusLabel: '支持对接',
        detail: '支持按企业现有认证体系与组织架构联合对接。',
      },
    ],
    booking: {
      title: '预约演示或咨询私有化部署',
      subtitle:
        '留下你的联系方式与业务场景，我们将在 1–2 个工作日内与你联系，安排 1 对 1 演示与方案答疑。',
      expectationsTitle: '预约沟通中你可以获得',
      expectations: [
        '针对你所在团队（金融、法务、财务、运营等）的真实文档交付现场演示',
        '敏感信息仿真脱敏、全量审计日志与私有化部署方案详解',
        '企业管理后台与统一模型接入的试点协助',
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
          '团队统一试用与额度管理',
          '企业内网私有化部署',
          '敏感信息仿真脱敏与全量审计日志',
          '对接企业内部模型与专业技能',
        ],
        notesLabel: '补充场景说明（选填）',
        notesPlaceholder:
          '例如：我们金融和法务团队需要本机处理合同与研报，重点关注敏感数据脱敏和全量审计日志…',
        consentText: '我同意 EvoWork 团队使用上述信息就本次预约与我联系。',
        submitLabel: '提交预约申请',
        submittingLabel: '正在提交…',
        previewModeNote: '提交后可直接确认预约信息，或通过下方兜底邮箱快速联系我们。',
        validationName: '请填写你的姓名',
        validationEmail: '请填写有效的工作邮箱地址',
        validationCompany: '请填写公司或团队名称',
        validationConsent: '请先勾选联系授权说明',
        successTitle: '预约信息已收到',
        successBody:
          '感谢你的联系！我们已收到你的预约申请，将在 1–2 个工作日内通过工作邮箱回复你。',
        successPreviewBody:
          '你的预约信息已校验完成。当前页面未绑定在线线索接口，点击下方邮箱按钮即可直接将预约内容发送给我们的企业顾问团队。',
        successReset: '提交另一条咨询',
        successDownloadCta: '先下载个人版免费体验',
        errorTitle: '提交暂时没有成功',
        errorFallback: '你的填写内容已保留，请稍后重试，或直接发邮件至',
      },
    },
  },
  footer: {
    copyright: '© 2026 EvoWork',
    licenseNote: '文件本机优先处理的桌面 AI 办公助手',
    links: [
      { label: '下载', page: 'download' },
      { label: '文档中心', page: 'docs', docSlug: 'quick-start' },
      { label: '安全与隐私', page: 'docs', docSlug: 'security-and-boundaries' },
      { label: '企业版', page: 'enterprise' },
    ],
  },
};
