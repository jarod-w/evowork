/** 智能体编辑辅助；运行协议与校验由本机服务负责。 */
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
export type {
  AgentRole,
  AgentWorkspaceItem,
  SingleAgentDraft,
  TeamAgentDraft,
  AgentTeamMember,
  AgentFlowNode,
} from '@evowork/store/agent-workspace-model';
import type {
  AgentWorkspaceItem,
  SingleAgentDraft,
  TeamAgentDraft,
  AgentTeamMember,
  AgentFlowNode,
} from '@evowork/store/agent-workspace-model';
export { agentFlowBatches } from '@evowork/store/agent-workspace-model';

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
export function newTeamAgent(singles: readonly SingleAgentDraft[]): TeamAgentDraft {
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
    name: '',
    description: '多位专家分析业务数据与行业变化，复核后形成经营分析报告。',
    skills: [...new Set(members.flatMap((m) => m.skills))],
    icon: 'team',
    example: false,
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
