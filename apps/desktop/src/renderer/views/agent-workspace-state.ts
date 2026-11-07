/** 前端评审模型。示例不代表已安装角色，所有编辑结果仅存于当前 App 会话。 */
export interface AgentCapability {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export const AGENT_SKILLS: readonly AgentCapability[] = [
  { id: 'documents', name: '文档处理', description: '整理材料，撰写报告与文档' },
  { id: 'analysis', name: '数据分析', description: '清洗数据，分析指标与趋势' },
  { id: 'search', name: '网页检索', description: '查找资料，整理来源与依据' },
  { id: 'writing', name: '内容创作', description: '撰写方案、文案与沟通内容' },
  { id: 'charts', name: '图表制作', description: '把分析结果转化为可视化图表' },
  { id: 'review', name: '内容审查', description: '核对材料与结论的一致性' },
];
export const AGENT_CONNECTORS: readonly AgentCapability[] = [
  { id: 'files', name: '本地文件', description: '任务工作目录中的文件' },
  { id: 'browser', name: '浏览器', description: '检索与浏览网页内容' },
  { id: 'feishu', name: '飞书', description: '示例选项 · 尚未接入' },
  { id: 'wecom', name: '企业微信', description: '示例选项 · 尚未接入' },
];
export const AGENT_ARCHITECTURES = [
  {
    id: 'supervisor',
    name: '主控调度',
    description: '主控分派任务，专家协作交付',
    icon: 'project',
  },
  {
    id: 'handoff',
    name: '自主交接',
    description: '依次完成工作，交接处理结果',
    icon: 'arrow-right',
  },
  { id: 'parallel', name: '并行协作', description: '独立处理，汇总多方结论', icon: 'team' },
  { id: 'custom', name: '自定义流程', description: '按节点顺序与进入条件执行', icon: 'settings' },
] as const;
export type AgentArchitecture = (typeof AGENT_ARCHITECTURES)[number]['id'];
export interface AgentRole {
  id: string;
  name: string;
  description: string;
  instructions: string;
  skills: string[];
  connectors: string[];
}
interface AgentBase extends AgentRole {
  example: boolean;
  icon: string;
}
export interface SingleAgentDraft extends AgentBase {
  kind: 'single';
}
export interface AgentTeamMember extends AgentRole {
  sourceAgentId?: string | undefined;
  lead: boolean;
}
export interface AgentFlowNode {
  id: string;
  name: string;
  memberId: string;
  input: string;
  output: string;
  condition: 'success' | 'review' | 'human';
}
export interface TeamAgentDraft extends AgentBase {
  kind: 'team';
  architecture: AgentArchitecture;
  members: AgentTeamMember[];
  nodes: AgentFlowNode[];
}
export type AgentWorkspaceItem = SingleAgentDraft | TeamAgentDraft;

export function newSingleAgent(): SingleAgentDraft {
  return {
    id: crypto.randomUUID(),
    kind: 'single',
    name: '',
    description: '',
    instructions: '',
    skills: [],
    connectors: ['files'],
    icon: 'agent',
    example: false,
  };
}
export function memberFromAgent(agent: SingleAgentDraft): AgentTeamMember {
  return {
    id: crypto.randomUUID(),
    sourceAgentId: agent.id,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skills: [...agent.skills],
    connectors: [...agent.connectors],
    lead: false,
  };
}
export function newTeamAgent(
  singles: readonly SingleAgentDraft[],
  example = false,
): TeamAgentDraft {
  const lead: AgentTeamMember = {
    ...newSingleAgent(),
    name: '主控智能体',
    description: '理解目标，分配任务，汇总结果并形成最终交付。',
    instructions: '明确目标、输入与交付标准。分派必要上下文，检查证据后汇总。',
    skills: ['documents'],
    lead: true,
  };
  const members = [lead, ...singles.slice(0, 3).map(memberFromAgent)];
  const node = (
    name: string,
    member: AgentTeamMember,
    input: string,
    output: string,
  ): AgentFlowNode => ({
    id: crypto.randomUUID(),
    name,
    memberId: member.id,
    input,
    output,
    condition: 'success',
  });
  return {
    ...newSingleAgent(),
    kind: 'team',
    name: example ? '经营分析协作团队' : '',
    description: '多位专家分析业务数据与行业变化，复核后形成经营分析报告。',
    skills: [...new Set(members.flatMap((m) => m.skills))],
    icon: 'team',
    example,
    architecture: 'supervisor',
    members,
    nodes: [
      node('理解目标与任务拆解', lead, '用户需求与输入材料', '任务目标、分工与交付标准'),
      ...members
        .slice(1)
        .map((m) => node(m.name, m, '主控分派的任务与必要材料', '包含依据的结构化分析结论')),
      node('汇总报告并交付', lead, '各节点的处理结果与证据', '经营分析报告'),
    ],
  };
}
export function createAgentWorkspaceExamples(): AgentWorkspaceItem[] {
  const examples: SingleAgentDraft[] = [
    {
      ...newSingleAgent(),
      id: 'example-report',
      name: '报告撰写助手',
      description: '把零散材料整理成结构清晰、重点突出的工作报告，让每一次交付都有条理。',
      instructions:
        '先确认用途、读者与交付格式。按背景、事实、分析、建议组织内容，信息不足时明确标注。',
      skills: ['documents', 'writing'],
      icon: 'file-text',
      example: true,
    },
    {
      ...newSingleAgent(),
      id: 'example-data',
      name: '数据分析专家',
      description: '从业务数据中发现趋势与异常，解释关键指标变化，并给出有依据的建议。',
      instructions: '核对数据口径与时间范围，再清洗与计算。每项结论附上指标依据，区分事实与推断。',
      skills: ['analysis', 'charts'],
      icon: 'pie-chart',
      example: true,
    },
    {
      ...newSingleAgent(),
      id: 'example-research',
      name: '行业研究助手',
      description: '检索行业动态，对比市场信息，整理可追溯的研究结论与参考资料。',
      instructions: '围绕研究问题检索多方来源，标明来源与日期，交叉核实关键事实。',
      skills: ['search', 'documents'],
      connectors: ['browser'],
      icon: 'compass',
      example: true,
    },
    {
      ...newSingleAgent(),
      id: 'example-review',
      name: '风险复核专家',
      description: '独立检查证据完整性和结论口径，帮助发现遗漏与潜在风险。',
      instructions: '逐条核对证据与结论，标注证据不足和口径冲突，输出复核意见与待处理清单。',
      skills: ['review', 'analysis'],
      icon: 'shield',
      example: true,
    },
  ];
  return [...examples, newTeamAgent(examples.slice(1), true)];
}
export function agentFlowBatches(team: TeamAgentDraft): AgentFlowNode[][] {
  const { nodes, architecture } = team;
  if (nodes.length < 3 || architecture === 'custom' || architecture === 'handoff')
    return nodes.map((n) => [n]);
  if (architecture === 'parallel')
    return [[nodes[0]!], nodes.slice(1, -1), [nodes.at(-1)!]].filter((b) => b.length > 0);
  if (nodes.length >= 5) return [[nodes[0]!], nodes.slice(1, 3), ...nodes.slice(3).map((n) => [n])];
  return nodes.map((n) => [n]);
}
export function validateAgentDraft(agent: AgentWorkspaceItem): string | undefined {
  if (!agent.name.trim()) return '请填写名称。';
  if (!agent.description.trim()) return '请填写角色说明或团队目标。';
  if (agent.kind === 'single') return agent.instructions.trim() ? undefined : '请填写工作指令。';
  if (agent.members.length < 2) return '请至少添加一位专业智能体。';
  if (agent.members.some((m) => !m.name.trim())) return '请为每个成员填写角色名称。';
  if (
    !agent.nodes.length ||
    agent.nodes.some((n) => !n.name.trim() || !agent.members.some((m) => m.id === n.memberId))
  )
    return '请补齐节点名称与执行角色。';
  return undefined;
}
