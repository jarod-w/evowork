export type Role = 'user' | 'dept' | 'platform' | 'security' | 'auditor' | 'finance';
export type SpaceId = 'sea' | 'jp';
export type TaskDecision = 'pending' | 'approved' | 'rejected' | 'edited';

export const PATH = {
  home: '/',
  connections: '/connections',
  memory: '/memory',
  me: '/me',
  dept: '/dept',
  deptPeople: '/dept/people',
  deptAgents: '/dept/agents',
  admin: '/admin',
  org: '/admin/org',
  models: '/admin/models',
  providers: '/admin/models/providers',
  catalog: '/admin/models/catalog',
  usage: '/admin/models/usage',
  data: '/admin/data',
  knowledge: '/admin/data/knowledge',
  memoryAdmin: '/admin/data/memory',
  agents: '/admin/agents',
  tools: '/admin/agents/tools',
  approvals: '/admin/agents/approvals',
  audit: '/admin/audit',
  ops: '/admin/ops',
  policy: '/admin/policy',
  policyNew: '/admin/policy/new',
} as const;

export const ADMIN_PATHS = [
  PATH.admin,
  PATH.org,
  PATH.models,
  PATH.providers,
  PATH.catalog,
  PATH.usage,
  PATH.data,
  PATH.knowledge,
  PATH.memoryAdmin,
  PATH.agents,
  PATH.tools,
  PATH.approvals,
  PATH.audit,
  PATH.ops,
  PATH.policy,
  PATH.policyNew,
] as const;

export const PERSONAS: { id: Role; name: string; title: string; hint: string }[] = [
  { id: 'user', name: '林可', title: '普通用户', hint: '财务共享中心' },
  { id: 'dept', name: '何兰', title: '部门管理员', hint: '管本部门知识库' },
  { id: 'platform', name: '李明', title: '平台管理员', hint: '组织、模型、运行' },
  { id: 'security', name: '陈安', title: '安全管理员', hint: '数据与 Agent 策略' },
  { id: 'auditor', name: '周宁', title: '合规审计员', hint: '只读' },
  { id: 'finance', name: '孙磊', title: '财务管理员', hint: '只看用量' },
];

export const DEPT_NAME = '财务共享中心';

export const SPACES: { id: SpaceId; name: string }[] = [
  { id: 'sea', name: '东南亚总部' },
  { id: 'jp', name: '日本子公司' },
];

export type Member = {
  name: string;
  email: string;
  dept: string;
  role: string;
  space: SpaceId;
  status: string;
};

export const MEMBERS: Member[] = [
  {
    name: '林可',
    email: 'lin.ke@hanlan.example',
    dept: '财务共享中心',
    role: '成员',
    space: 'sea',
    status: '正常',
  },
  {
    name: '何兰',
    email: 'he.lan@hanlan.example',
    dept: '财务共享中心',
    role: '部门管理员',
    space: 'sea',
    status: '正常',
  },
  {
    name: '李明',
    email: 'li.ming@hanlan.example',
    dept: '平台',
    role: '平台管理员',
    space: 'sea',
    status: '正常',
  },
  {
    name: '陈安',
    email: 'chen.an@hanlan.example',
    dept: '信息安全',
    role: '安全管理员',
    space: 'sea',
    status: '正常',
  },
  {
    name: '周宁',
    email: 'zhou.ning@hanlan.example',
    dept: '合规',
    role: '合规审计员',
    space: 'sea',
    status: '正常',
  },
  {
    name: '孙磊',
    email: 'sun.lei@hanlan.example',
    dept: '财务',
    role: '财务管理员',
    space: 'sea',
    status: '正常',
  },
  {
    name: '周启明',
    email: 'zhou.qiming@hanlan.example',
    dept: '财务共享中心',
    role: 'Agent 构建者',
    space: 'sea',
    status: '正常',
  },
  {
    name: '山田葵',
    email: 'a.yamada@hanlan.example',
    dept: '东京办公室',
    role: '成员',
    space: 'jp',
    status: '正常',
  },
];

export type AgentCard = {
  id: string;
  name: string;
  owner: string;
  space: SpaceId;
  risk: string;
  version: string;
  people: number;
  lastUsed: string;
  gate: 'open' | 'publish';
  purpose: string;
  data: string[];
  tools: string[];
  limits: string[];
};

export const AGENTS: AgentCard[] = [
  {
    id: 'minutes',
    name: '会议纪要',
    owner: '周启明',
    space: 'sea',
    risk: '低',
    version: '2.4',
    people: 38,
    lastUsed: '今天 14:10',
    gate: 'open',
    purpose: '把会议材料整理成纪要和行动项。',
    data: ['本次任务上传的文件', 'SharePoint 财务制度库（只读）'],
    tools: ['文档解析', '生成 Word'],
    limits: ['不能替你发送邮件', '不能访问其他空间的资料'],
  },
  {
    id: 'mail',
    name: '邮件草稿',
    owner: '周启明',
    space: 'sea',
    risk: '中',
    version: '1.6',
    people: 21,
    lastUsed: '昨天',
    gate: 'open',
    purpose: '按你的口径起草内部邮件。发送必须你本人批准。',
    data: ['当前任务中的草稿', '你的 Outlook 通讯录'],
    tools: ['Outlook 草稿', 'Outlook 发送（需批准）'],
    limits: ['默认只发给内部域名', '外部收件人要另批'],
  },
  {
    id: 'recon',
    name: '月结差异说明',
    owner: '周启明',
    space: 'sea',
    risk: '中',
    version: '1.2',
    people: 9,
    lastUsed: '10月28日',
    gate: 'open',
    purpose: '对照台账说明月结差异，数字用表格算。',
    data: ['任务目录里的表格', 'SharePoint 月结文件夹（只读）'],
    tools: ['表格计算', 'SharePoint 读取'],
    limits: ['不写回源系统', '高敏感列不进入模型'],
  },
  {
    id: 'contract',
    name: '合同条款审阅',
    owner: '周启明',
    space: 'sea',
    risk: '高',
    version: '3',
    people: 0,
    lastUsed: '尚未发布',
    gate: 'publish',
    purpose: '标出合同里的责任、期限和例外条款。',
    data: ['上传的合同 PDF', '条款清单（内部）'],
    tools: ['文档解析'],
    limits: ['不给出法律意见', '不外发合同正文'],
  },
];

export type ChatMessage = {
  from: 'user' | 'agent';
  text: string;
  cite?: { title: string; place: string };
};

export type Task = {
  id: string;
  title: string;
  agentId: string;
  updated: string;
  status: string;
  tokens: number;
  tightened: boolean;
  messages: ChatMessage[];
  approval?: { action: string; data: string; scope: string };
};

export const TASKS: Task[] = [
  {
    id: 'minutes',
    title: '10月经营会纪要',
    agentId: 'minutes',
    updated: '今天 14:10',
    status: '等待你批准发送',
    tokens: 12400,
    tightened: false,
    messages: [
      { from: 'user', text: '根据附件整理 10 月经营会纪要，行动项用表格。' },
      {
        from: 'agent',
        text: '纪要已整理。收入指引来自经营会材料，不是模型推断。发给内部邮件列表之前，需要你确认收件人和正文。',
        cite: { title: '经营会材料.pdf', place: '第 3 页' },
      },
    ],
    approval: {
      action: '通过 Outlook 发送这封纪要',
      data: '收件人 finance-sg@hanlan.example 等 12 人，域名都在公司内部',
      scope: '1 封邮件，附件为纪要 Word',
    },
  },
  {
    id: 'recon',
    title: '供应商对账差异',
    agentId: 'recon',
    updated: '10月28日',
    status: '已完成',
    tokens: 8600,
    tightened: true,
    messages: [
      { from: 'user', text: '说明这三家供应商的月结差异。' },
      {
        from: 'agent',
        text: '上传文件里有证件号，已拦截，没有发给模型。这个对话已收紧，之后不能使用外发工具。差异说明只根据台账数字写成。',
      },
    ],
  },
  {
    id: 'mail',
    title: '给审计的说明邮件',
    agentId: 'mail',
    updated: '昨天 18:02',
    status: '等待你的电脑继续',
    tokens: 3100,
    tightened: false,
    messages: [
      { from: 'user', text: '起草一封给内部审计的说明，先不要发。' },
      {
        from: 'agent',
        text: '草稿已写好，放在这台电脑的任务目录里。网页上看不到附件，也不能从这里继续写。',
      },
    ],
  },
];

export const PERSONAL_USAGE = [
  { agent: '会议纪要', tokens: 102_400 },
  { agent: '邮件草稿', tokens: 61_200 },
  { agent: '月结差异说明', tokens: 22_640 },
];

export const PERSONAL_LIMIT = 300_000;

export const PERSONAL_USED = PERSONAL_USAGE.reduce((sum, row) => sum + row.tokens, 0);

export const DEPT_ADMIN_USAGE = [{ agent: '会议纪要', tokens: 18_400 }];

export const DEPT_ADMIN_LIMIT = 300_000;

export const DEPT_ADMIN_USED = DEPT_ADMIN_USAGE.reduce((sum, row) => sum + row.tokens, 0);

export const DEPT_ADMIN_MEMORIES = [
  {
    id: 'dept-pref',
    text: '月结说明用简体中文，金额保留两位小数。',
    source: '对话',
    level: '内部',
  },
];

export type DeptUsage = { dept: string; used: number; limit: number };

export const DEPT_USAGE: Record<SpaceId, DeptUsage[]> = {
  sea: [
    { dept: '财务共享中心', used: 1_680_000, limit: 2_000_000 },
    { dept: '合规', used: 410_000, limit: 1_000_000 },
    { dept: '投行', used: 790_000, limit: 1_500_000 },
  ],
  jp: [{ dept: '东京办公室', used: 320_000, limit: 1_000_000 }],
};

export const CONNECTIONS = [
  { id: 'outlook', name: 'Outlook', detail: '用你自己的账号起草和发送邮件' },
  { id: 'sharepoint', name: 'SharePoint · 财务制度库', detail: '只读。范围是财务共享站点' },
  { id: 'slack', name: 'Slack', detail: '尚未授权。授权在客户端完成' },
];

export const MEMORIES = [
  { id: 'm1', text: '纪要用中文，行动项放在表格里。', source: '来自你 9 月的更正', level: '内部' },
  { id: 'm2', text: '月结金额用新加坡元，不换算成美元。', source: '来自月结任务', level: '内部' },
  { id: 'm3', text: '给审计的邮件先写草稿，不直接发送。', source: '来自你的偏好', level: '内部' },
];

export const SESSIONS = [
  { id: 'browser', device: '当前浏览器', place: '新加坡', when: '今天 14:02', current: true },
  {
    id: 'mac',
    device: 'EvoWork 客户端 · Mac',
    place: '新加坡',
    when: '今天 09:18',
    current: false,
  },
  { id: 'old', device: '旧的浏览器会话', place: '新加坡', when: '10月20日', current: false },
];

export const CHANGES = [
  {
    id: 'publish',
    kind: '发布',
    title: '合同条款审阅 v3',
    by: '周启明',
    wait: '安全管理员陈安',
    approver: 'security',
  },
  {
    id: 'egress',
    kind: '出口白名单',
    title: '增加 api.slack.com',
    by: '赵衡',
    wait: '另一名平台管理员',
    approver: 'platform',
  },
] as const;

export type ChangeId = (typeof CHANGES)[number]['id'];

export const DEVICES = [
  { name: '林可的 Mac', version: 14 },
  { name: '李明的 Mac', version: 14 },
  { name: '财务室公用电脑', version: 13 },
  { name: '东京笔记本', version: 14 },
];

export type PolicyBody = {
  name: string;
  note: string;
  reason: string;
  expiresInDays: number;
  confidentialNeedsAssessedModel: boolean;
  highSecretNoMemory: boolean;
  allowCustomModel: boolean;
  userMemorySea: boolean;
  userMemoryJp: boolean;
  teamMemory: boolean;
  defaultToolsNone: boolean;
};

export type PolicyPack = PolicyBody & {
  id: string;
  version: number;
  createdBy: string;
  createdRole: 'platform' | 'security';
  createdAt: string;
  signedBy: string;
  signedAt: string;
};

export type PolicyDraft = PolicyBody & {
  createdBy: string;
  createdRole: 'platform' | 'security';
  createdAt: string;
};

export const SEED_POLICY: PolicyPack = {
  id: 'pack-14',
  version: 14,
  name: '东南亚基线',
  note: '机密及以上只走已评估模型；高度机密不进长期记忆；成员不能自备模型；工具默认关闭。',
  reason: '公司要求模型、记忆和工具按已批准的范围使用。',
  expiresInDays: 90,
  confidentialNeedsAssessedModel: true,
  highSecretNoMemory: true,
  allowCustomModel: false,
  userMemorySea: true,
  userMemoryJp: false,
  teamMemory: false,
  defaultToolsNone: true,
  createdBy: '陈安',
  createdRole: 'security',
  createdAt: '今天 09:20',
  signedBy: '李明',
  signedAt: '今天 11:02',
};

export function issuedPolicy(packs: PolicyPack[]) {
  return packs.reduce((best, pack) => (pack.version > best.version ? pack : best));
}

export type ProviderKind = 'bedrock' | 'openai';
export type ProviderAuth = 'iam' | 'vault';

export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  endpoint: string;
  auth: ProviderAuth;
  vaultRef: string;
  enabled: boolean;
  assessed: boolean;
  assessor: string;
  assessedOn: string;
};

export type CatalogModel = {
  id: string;
  name: string;
  providerId: string;
  version: string;
  context: number;
  price: string;
  place: string;
  keep: string;
  train: string;
  tools: boolean;
  structured: boolean;
  enabled: boolean;
  assessed: boolean;
  assessor: string;
  assessedOn: string;
};

export const SEED_PROVIDERS: Provider[] = [
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    kind: 'bedrock',
    endpoint: 'ap-southeast-1',
    auth: 'iam',
    vaultRef: '',
    enabled: true,
    assessed: true,
    assessor: '陈安',
    assessedOn: '2026-10-20',
  },
  {
    id: 'local',
    name: '客户机房兼容端点',
    kind: 'openai',
    endpoint: 'https://llm.hanlan.internal/v1',
    auth: 'vault',
    vaultRef: 'vault/local-llm',
    enabled: true,
    assessed: true,
    assessor: '陈安',
    assessedOn: '2026-10-18',
  },
  {
    id: 'custom',
    name: '未命名自定义端点',
    kind: 'openai',
    endpoint: 'https://llm.example.invalid/v1',
    auth: 'vault',
    vaultRef: '',
    enabled: false,
    assessed: false,
    assessor: '',
    assessedOn: '',
  },
];

export const SEED_MODELS: CatalogModel[] = [
  {
    id: 'sonnet',
    name: 'Claude Sonnet',
    providerId: 'bedrock',
    version: 'sonnet-5',
    context: 200000,
    price: '按 Bedrock 价目',
    place: 'ap-southeast-1 · 区域内',
    keep: '不留存',
    train: '不用于训练',
    tools: true,
    structured: true,
    enabled: true,
    assessed: true,
    assessor: '陈安',
    assessedOn: '2026-10-20',
  },
  {
    id: 'haiku',
    name: 'Claude Haiku',
    providerId: 'bedrock',
    version: 'haiku-4',
    context: 200000,
    price: '按 Bedrock 价目',
    place: 'ap-southeast-1 · 区域内',
    keep: '不留存',
    train: '不用于训练',
    tools: true,
    structured: true,
    enabled: true,
    assessed: true,
    assessor: '陈安',
    assessedOn: '2026-10-20',
  },
  {
    id: 'local-chat',
    name: '机房通用',
    providerId: 'local',
    version: '2026-10-01',
    context: 32768,
    price: '客户自建，无外部单价',
    place: '客户本地',
    keep: '客户自管',
    train: '不用于训练',
    tools: true,
    structured: false,
    enabled: true,
    assessed: true,
    assessor: '陈安',
    assessedOn: '2026-10-18',
  },
];

export function usableModels(models: CatalogModel[], providers: Provider[]) {
  const open = new Set(
    providers.filter((item) => item.enabled && item.assessed).map((item) => item.id),
  );
  return models.filter((item) => item.enabled && item.assessed && open.has(item.providerId));
}

export const DLP_RULES = [
  { name: '新加坡 NRIC / FIN', action: '拦截', source: '内置' },
  { name: '邮箱、电话', action: '打码', source: '内置' },
  { name: '日本个人编号', action: '拦截', source: '内置' },
  { name: '内部项目代号', action: '告警', source: '自定义' },
];

export type KnowledgeSource = {
  id: string;
  name: string;
  dept: string;
  state: '同步成功' | '失败' | '已停用';
  when: string;
  level: '内部' | '机密';
  note: string;
  enabled: boolean;
};

export const SEED_SOURCES: KnowledgeSource[] = [
  {
    id: 'fin-policy',
    name: 'SharePoint · 财务制度',
    dept: '财务共享中心',
    state: '同步成功',
    when: '2 小时前',
    level: '机密',
    note: '只读，权限映射正常',
    enabled: true,
  },
  {
    id: 'fin-close',
    name: '对象存储 · 月结归档',
    dept: '财务共享中心',
    state: '同步成功',
    when: '昨天',
    level: '内部',
    note: '只读账号',
    enabled: true,
  },
  {
    id: 'fin-scan',
    name: 'SharePoint · 扫描件台账',
    dept: '财务共享中心',
    state: '失败',
    when: '今天 08:40',
    level: '机密',
    note: '权限映射失败，文档默认不可见',
    enabled: true,
  },
  {
    id: 'comp-wiki',
    name: 'Confluence · 合规手册',
    dept: '合规',
    state: '失败',
    when: '今天 08:12',
    level: '机密',
    note: '权限映射失败，文档默认不可见',
    enabled: true,
  },
];

export const TOOL_GRANTS = [
  { id: 'doc', agent: '会议纪要', tool: '文档解析', mode: '读', risk: '低' },
  { id: 'outlook', agent: '邮件草稿', tool: 'Outlook 发送', mode: '写', risk: '高' },
  { id: 'sp', agent: '月结差异说明', tool: 'SharePoint 读取', mode: '读', risk: '中' },
];

export const APPROVAL_RULES = [
  { tool: '发送邮件', when: '收件人含外部域名', who: '成员本人，超时拒绝', timeout: '默认拒绝' },
  { tool: '发送邮件', when: '收件人全是内部域名', who: '成员本人确认', timeout: '默认拒绝' },
  { tool: '写入 SharePoint', when: '任何写入', who: '空间负责人', timeout: '默认拒绝' },
  { tool: '导出含机密的文件', when: '分级达到机密', who: '成员本人确认', timeout: '默认拒绝' },
];

export const AUDIT_SEED: AuditRow[] = [
  {
    id: 'a1',
    time: '今天 14:10',
    actor: '林可',
    space: '东南亚总部',
    action: '等待审批',
    target: '发送经营会纪要',
    result: '待处理',
    trace: 'tr-20481',
  },
  {
    id: 'a2',
    time: '今天 11:02',
    actor: '李明',
    space: '东南亚总部',
    action: '签发策略',
    target: '策略包 v14',
    result: '成功',
    trace: 'tr-20440',
  },
  {
    id: 'a2b',
    time: '今天 09:20',
    actor: '陈安',
    space: '东南亚总部',
    action: '创建策略',
    target: '东南亚基线',
    result: '草稿',
    trace: 'tr-20440',
  },
  {
    id: 'a3',
    time: '今天 09:40',
    actor: '系统',
    space: '东南亚总部',
    action: '敏感信息拦截',
    target: '供应商对账上传文件',
    result: '已拦截',
    trace: 'tr-20402',
  },
  {
    id: 'a4',
    time: '昨天 16:18',
    actor: '赵衡',
    space: '东南亚总部',
    action: '提交变更',
    target: '出口白名单 api.slack.com',
    result: '待第二人审批',
    trace: 'tr-20311',
  },
  {
    id: 'a5',
    time: '昨天 15:02',
    actor: '周启明',
    space: '东南亚总部',
    action: '提交发布',
    target: '合同条款审阅 v3',
    result: '待安全审批',
    trace: 'tr-20302',
  },
];

export type AuditRow = {
  id: string;
  time: string;
  actor: string;
  space: string;
  action: string;
  target: string;
  result: string;
  trace: string;
};

export const HEALTH = [
  { name: '模型网关', state: '正常', detail: '错误率 0.4%' },
  { name: '目录同步', state: '正常', detail: '2 分钟前' },
  { name: '知识库索引', state: '延迟', detail: '3 篇解析失败' },
  { name: '审计导出', state: '正常', detail: 'SIEM 已连接' },
];

export const DATA_FLOW = `瀚澜资本 · 数据流说明（原型）
存储位置：客户 VPC，新加坡 ap-southeast-1。
模型处理：Claude 经 Amazon Bedrock，区域内调用，不留存、不用于训练。
员工电脑上的任务文件留在本机，不因为打开这个网页而上传。
日志默认只记元数据。诊断包不含提示词和正文。
此文件用于内部评审演示，不是正式的合规意见。
`;

export function persona(role: Role) {
  return PERSONAS.find((item) => item.id === role) ?? PERSONAS[0];
}

export function formatTokens(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function percent(used: number, limit: number) {
  if (limit <= 0) return 0;
  return Math.round((used / limit) * 100);
}

export function matches(query: string, ...parts: string[]) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.join('\n').toLowerCase().includes(needle);
}

export function adminNav(role: Role) {
  const items: { href: string; label: string; roles: Role[] }[] = [
    { href: PATH.admin, label: '概览', roles: ['platform', 'security', 'auditor', 'finance'] },
    { href: PATH.org, label: '组织', roles: ['platform', 'security'] },
    { href: PATH.models, label: '模型与成本', roles: ['platform', 'security', 'finance'] },
    { href: PATH.data, label: '数据', roles: ['platform', 'security'] },
    { href: PATH.policy, label: '策略', roles: ['platform', 'security', 'auditor'] },
    { href: PATH.agents, label: 'Agent', roles: ['platform', 'security'] },
    { href: PATH.audit, label: '审计', roles: ['platform', 'security', 'auditor'] },
    { href: PATH.ops, label: '运行', roles: ['platform'] },
  ];
  return items.filter((item) => item.roles.includes(role));
}

export function canEditOrg(role: Role) {
  return role === 'platform';
}

export function canEditRouting(role: Role) {
  return role === 'platform';
}

export function canEditPolicy(role: Role) {
  return role === 'platform' || role === 'security';
}

export function canKill(role: Role) {
  return role === 'platform' || role === 'security';
}

export function canApprove(role: Role, changeId: ChangeId) {
  return CHANGES.find((item) => item.id === changeId)?.approver === role;
}

export function guard(role: Role, pathname: string, selfService: boolean) {
  if (pathname.startsWith('/tasks/')) {
    const id = pathname.slice('/tasks/'.length);
    if (role === 'dept') return PATH.dept;
    if (role !== 'user') return PATH.admin;
    return TASKS.some((task) => task.id === id) ? pathname : PATH.home;
  }
  const personal =
    pathname === PATH.home ||
    pathname === PATH.connections ||
    pathname === PATH.me ||
    pathname === PATH.memory;
  const deptPath = pathname === PATH.dept || pathname.startsWith(`${PATH.dept}/`);
  if (role === 'user') {
    if (deptPath || pathname.startsWith('/admin')) return PATH.home;
    if (pathname === PATH.memory && !selfService) return PATH.home;
    if (personal) return pathname;
    return PATH.home;
  }
  if (role === 'dept') {
    if (pathname.startsWith('/admin')) return PATH.dept;
    if (pathname === PATH.memory && !selfService) return PATH.home;
    if (personal || deptPath) return pathname;
    return PATH.dept;
  }
  if (personal || deptPath || !pathname.startsWith('/admin')) return PATH.admin;
  if (role === 'auditor' && pathname === PATH.policyNew) return PATH.policy;
  if (
    role === 'auditor' &&
    pathname !== PATH.admin &&
    pathname !== PATH.policy &&
    !pathname.startsWith(PATH.audit)
  ) {
    return PATH.admin;
  }
  if (role === 'finance' && pathname !== PATH.admin && !pathname.startsWith(PATH.models)) {
    return PATH.admin;
  }
  if (role === 'finance' && pathname.startsWith(PATH.models) && pathname !== PATH.usage) {
    return PATH.usage;
  }
  if (role === 'security' && pathname.startsWith(PATH.ops)) return PATH.admin;
  if (!(ADMIN_PATHS as readonly string[]).includes(pathname)) return PATH.admin;
  return pathname;
}

const ROLE_SET = new Set<string>(PERSONAS.map((item) => item.id));

export function parseRole(search: string, pathname: string): Role {
  const value = new URLSearchParams(search).get('as');
  if (value && ROLE_SET.has(value)) return value as Role;
  return pathname.startsWith('/admin') ? 'platform' : 'user';
}

export function searchTarget(role: Role, query: string) {
  const text = query.trim();
  if (role === 'dept') return PATH.dept;
  if (role === 'finance') return PATH.usage;
  if (role === 'auditor') return PATH.audit;
  if (text && AGENTS.some((agent) => agent.name.includes(text))) return PATH.agents;
  if (
    text &&
    MEMBERS.some(
      (member) =>
        member.name.includes(text) || member.email.toLowerCase().includes(text.toLowerCase()),
    )
  ) {
    return PATH.org;
  }
  return PATH.audit;
}
