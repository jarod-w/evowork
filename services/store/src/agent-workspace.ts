import type { Store } from './store.js';
import type { AgentWorkspaceItem, AgentWorkspaceRun, AgentRole } from './agent-workspace-model.js';

/** IPC 是不可信输入。只保存已识别字段，拒绝悬空节点和不可执行的能力。 */
export function parseAgentWorkspace(value: unknown): AgentWorkspaceItem {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('智能体配置格式错误。');
    return v as Record<string, unknown>;
  };
  const str = (v: unknown, max = 16000, required = true): string => {
    if (typeof v !== 'string' || v.length > max || (required && !v.trim()))
      throw new Error('请补齐智能体名称、角色说明、工作指令或节点字段，并检查长度。');
    return v.trim();
  };
  const ids = (v: unknown, allowed: string[]): string[] => {
    if (!Array.isArray(v) || v.length > 20 || v.some((id) => !allowed.includes(id)))
      throw new Error('包含尚未接入的技能或连接器，请重新选择。');
    return [...new Set(v as string[])];
  };
  const role = (v: unknown, team = false): AgentRole => {
    const r = object(v);
    return {
      id: str(r.id, 100),
      name: str(r.name, 100),
      description: str(r.description, 4000),
      instructions: str(r.instructions, 16000, !team),
      skills: ids(r.skills, ['documents', 'analysis', 'search', 'writing', 'charts', 'review']),
      connectors: ids(r.connectors, ['files', 'browser']),
    };
  };
  const r = object(value);
  const revision = r.revision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 1))
    throw new Error('配置版本无效，请重新加载。');
  const base = {
    ...role(r, r.kind === 'team'),
    icon: str(r.icon, 60),
    example: false,
    ...(revision === undefined ? {} : { revision: revision as number }),
  };
  if (r.kind === 'single') return { ...base, kind: 'single' };
  if (
    r.kind !== 'team' ||
    !['supervisor', 'handoff', 'parallel', 'custom'].includes(String(r.architecture))
  )
    throw new Error('未知的智能体类型或协作方式。');
  if (!Array.isArray(r.members) || r.members.length < 2 || r.members.length > 12)
    throw new Error('团队需要 2 至 12 位成员。');
  const members = r.members.map((m) => {
    const raw = object(m);
    if (typeof raw.lead !== 'boolean') throw new Error('成员角色无效。');
    return {
      ...role(m),
      lead: raw.lead,
      ...(raw.sourceAgentId === undefined ? {} : { sourceAgentId: str(raw.sourceAgentId, 100) }),
    };
  });
  if (
    new Set(members.map((m) => m.id)).size !== members.length ||
    members.filter((m) => m.lead).length !== 1
  )
    throw new Error('成员标识必须唯一，且团队必须有一位主控。');
  if (!Array.isArray(r.nodes) || !r.nodes.length || r.nodes.length > 40)
    throw new Error('请配置 1 至 40 个流程节点。');
  const nodes = r.nodes.map((v) => {
    const n = object(v);
    const memberId = str(n.memberId, 100);
    if (
      !members.some((m) => m.id === memberId) ||
      !['success', 'review', 'human'].includes(String(n.condition))
    )
      throw new Error('请检查节点执行角色和完成条件。');
    return {
      id: str(n.id, 100),
      name: str(n.name, 100),
      memberId,
      input: str(n.input, 4000, false),
      output: str(n.output, 4000, false),
      condition: n.condition as 'success' | 'review' | 'human',
    };
  });
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) throw new Error('节点标识必须唯一。');
  return {
    ...base,
    kind: 'team',
    architecture: r.architecture as 'supervisor' | 'handoff' | 'parallel' | 'custom',
    members,
    nodes,
  };
}

export class AgentWorkspaceStore {
  constructor(private readonly store: Store) {}
  list(): AgentWorkspaceItem[] {
    return (
      this.store.db
        .prepare('SELECT payload FROM agent_workspace ORDER BY updated_at DESC, id')
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as AgentWorkspaceItem);
  }
  get(id: string): AgentWorkspaceItem {
    const row = this.store.db
      .prepare('SELECT payload FROM agent_workspace WHERE id = ?')
      .get(id) as { payload: string } | undefined;
    if (!row) throw new Error('智能体配置不存在，请刷新列表。');
    return JSON.parse(row.payload) as AgentWorkspaceItem;
  }
  save(value: unknown): AgentWorkspaceItem {
    const item = parseAgentWorkspace(value);
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare('SELECT revision FROM agent_workspace WHERE id = ?')
        .get(item.id) as { revision: number } | undefined;
      if ((row?.revision ?? undefined) !== item.revision)
        throw new Error('配置已改变，请重新打开后再保存。');
      const saved = { ...item, revision: (row?.revision ?? 0) + 1 };
      this.store.db
        .prepare(
          'INSERT INTO agent_workspace(id, revision, payload, updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at',
        )
        .run(item.id, saved.revision, JSON.stringify(saved), Date.now());
      return saved;
    });
  }
  remove(id: string, revision: number): void {
    this.store.transaction(() => {
      if (this.runs(id).some((run) => run.status === 'running' || run.status === 'waiting'))
        throw new Error('团队正在运行，请先停止运行后再删除配置。');
      const result = this.store.db
        .prepare('DELETE FROM agent_workspace WHERE id = ? AND revision = ?')
        .run(id, revision) as { changes: number };
      if (!Number(result.changes)) throw new Error('配置已改变或删除，请刷新列表。');
    });
  }
  saveRun(run: AgentWorkspaceRun): void {
    this.store.db
      .prepare(
        'INSERT INTO agent_workspace_run(id,agent_id,payload,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(run.id, run.agent.id, JSON.stringify(run), run.createdAt);
  }
  runs(agentId?: string): AgentWorkspaceRun[] {
    const rows = (
      agentId
        ? this.store.db
            .prepare(
              'SELECT payload FROM agent_workspace_run WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100',
            )
            .all(agentId)
        : this.store.db
            .prepare('SELECT payload FROM agent_workspace_run ORDER BY created_at DESC')
            .all()
    ) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as AgentWorkspaceRun);
  }
  run(id: string): AgentWorkspaceRun {
    const row = this.store.db
      .prepare('SELECT payload FROM agent_workspace_run WHERE id = ?')
      .get(id) as { payload: string } | undefined;
    if (!row) throw new Error('运行记录不存在。');
    return JSON.parse(row.payload) as AgentWorkspaceRun;
  }
}
