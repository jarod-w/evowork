/** 智能体配置与运行的本机协议；不依赖渲染层。 */
export type AgentArchitecture = 'supervisor' | 'handoff' | 'parallel' | 'custom';
export interface AgentRole {
  id: string;
  name: string;
  description: string;
  instructions: string;
  skills: string[];
  connectors: string[];
}
interface AgentBase extends AgentRole {
  revision?: number | undefined;
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

export function agentFlowBatches(team: TeamAgentDraft): AgentFlowNode[][] {
  const { nodes, architecture } = team;
  if (nodes.length < 3 || architecture === 'custom' || architecture === 'handoff')
    return nodes.map((n) => [n]);
  if (architecture === 'parallel')
    return [[nodes[0]!], nodes.slice(1, -1), [nodes.at(-1)!]].filter((b) => b.length > 0);
  if (nodes.length >= 5) return [[nodes[0]!], nodes.slice(1, 3), ...nodes.slice(3).map((n) => [n])];
  return nodes.map((n) => [n]);
}

export type AgentRunStatus =
  'running' | 'waiting' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export interface AgentNodeRun {
  nodeId: string;
  threadId?: string | undefined;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';
  output: string;
  confirmed: boolean;
}
export interface AgentWorkspaceRun {
  id: string;
  agent: TeamAgentDraft;
  prompt: string;
  cwd: string;
  concurrencyLimit?: number;
  budgetLimit?: number;
  modelId?: string | undefined;
  status: AgentRunStatus;
  batch: number;
  nodes: AgentNodeRun[];
  logs: string[];
  createdAt: number;
}
