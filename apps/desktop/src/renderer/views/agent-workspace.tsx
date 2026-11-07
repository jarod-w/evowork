import type { AgentWorkspaceActions } from '../../shared/ipc.js';
import type { AgentWorkspaceRun } from '@evowork/store/agent-workspace-model';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { renderIcon } from '../components/icons.js';
import {
  Badge,
  Dialog,
  EmptyState,
  GhostButton,
  IconButton,
  PillButton,
  SearchInput,
  SegmentedControl,
} from '../components/primitives.js';
import type { SettingsLeaveGuard } from '../components/settings-controls.js';
import {
  AGENT_ARCHITECTURES,
  AGENT_CONNECTORS,
  AGENT_SKILLS,
  agentFlowBatches,
  memberFromAgent,
  newSingleAgent,
  newTeamAgent,
  validateAgentDraft,
  type AgentCapability,
  type AgentFlowNode,
  type AgentRole,
  type AgentWorkspaceItem,
  type SingleAgentDraft,
  type TeamAgentDraft,
} from './agent-workspace-state.js';

export interface AgentWorkspacePageProps {
  readonly actions?: Partial<AgentWorkspaceActions> | undefined;
  readonly modelId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly onOpenTask?: ((id: string) => void) | undefined;
  readonly onConversation?: ((id: string, text: string) => Promise<void>) | undefined;
  readonly items: readonly AgentWorkspaceItem[];
  readonly onItemsChange: (items: readonly AgentWorkspaceItem[]) => void;
  readonly onRegisterLeaveGuard?: ((guard: SettingsLeaveGuard | null) => void) | undefined;
}
type TeamTab = 'team' | 'flow' | 'monitor';
type RunPreview = {
  status: 'idle' | 'running' | 'waiting' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  batch: number;
  completed: string[];
  confirmed: string[];
  logs: string[];
};
const RUN_COPY = {
  idle: '待运行',
  running: '运行中',
  failed: '失败',
  interrupted: '已中断',
  waiting: '等待确认',
  completed: '已完成',
  stopped: '已停止',
} as const;
const EMPTY_RUN: RunPreview = { status: 'idle', batch: 0, completed: [], confirmed: [], logs: [] };
const copy = <T,>(value: T): T => structuredClone(value);
const capabilityNames = (ids: readonly string[]) =>
  ids.map((id) => AGENT_SKILLS.find((s) => s.id === id)?.name ?? id);

/** 本机配置与真实任务运行视图。 */
export function AgentWorkspacePage({
  items,
  actions,
  modelId,
  workspaceId,
  onConversation,
  onOpenTask,
  onItemsChange,
  onRegisterLeaveGuard,
}: AgentWorkspacePageProps) {
  const [editor, setEditor] = useState<AgentWorkspaceItem | null>(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [teamTab, setTeamTab] = useState<TeamTab>('team');
  const [memberId, setMemberId] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentWorkspaceItem | null>(null);
  const [manageTarget, setManageTarget] = useState<AgentWorkspaceItem | null>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [chat, setChat] = useState<SingleAgentDraft | null>(null);
  const [chatPrompt, setChatPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [runPrompt, setRunPrompt] = useState('');
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [realRun, setRealRun] = useState<AgentWorkspaceRun | null>(null);
  const run: RunPreview = realRun
    ? {
        status: realRun.status,
        batch: realRun.batch,
        completed: realRun.nodes.filter((n) => n.status === 'completed').map((n) => n.nodeId),
        confirmed: realRun.nodes.filter((n) => n.confirmed).map((n) => n.nodeId),
        logs: realRun.logs,
      }
    : EMPTY_RUN;
  const fail = (error: unknown) =>
    setFeedback(error instanceof Error ? error.message : '操作失败，请重试。');
  useEffect(() => {
    let cancelled = false;
    if (!actions?.listAgentWorkspace) {
      setFeedback('智能体服务不可用。');
      return;
    }
    void actions
      .listAgentWorkspace()
      .then((values) => {
        if (!cancelled) onItemsChange(values);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [actions, onItemsChange]);
  useEffect(() => {
    if (!editor || editor.kind !== 'team' || !actions?.getAgentWorkspaceRun) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await actions.getAgentWorkspaceRun!({ agentId: editor.id });
        if (!cancelled) setRealRun(value ?? null);
      } catch (error) {
        if (!cancelled) fail(error);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [editor?.id, actions]);
  const decide = async (action: 'confirm' | 'stop', nodeId?: string) => {
    if (!realRun || !actions?.decideAgentWorkspaceRun || busy) return;
    setBusy(true);
    try {
      setRealRun(await actions.decideAgentWorkspaceRun({ runId: realRun.id, nodeId, action }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const baseline = useRef('');
  const dirty = editor !== null && JSON.stringify(editor) !== baseline.current;
  const running = run.status === 'running' || run.status === 'waiting';
  const leaveState = useRef({ dirty, running });
  leaveState.current = { dirty, running };
  const leaveResolve = useRef<((allowed: boolean) => void) | null>(null);
  const leavePromise = useRef<Promise<boolean> | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const requestLeave = useCallback((): Promise<boolean> => {
    if (!leaveState.current.dirty) return Promise.resolve(true);
    if (leavePromise.current) return leavePromise.current;
    leavePromise.current = new Promise((resolve) => {
      leaveResolve.current = resolve;
    });
    setLeavePrompt(true);
    return leavePromise.current;
  }, []);
  useEffect(() => {
    onRegisterLeaveGuard?.(requestLeave);
    return () => {
      onRegisterLeaveGuard?.(null);
      leaveResolve.current?.(false);
    };
  }, [onRegisterLeaveGuard, requestLeave]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (leaveState.current.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [editor?.id, editor?.kind, teamTab]);

  const team =
    editor?.kind === 'team' ? (teamTab === 'monitor' && realRun ? realRun.agent : editor) : null;
  const batches = team ? agentFlowBatches(team) : [];
  const currentBatch = batches[run.batch] ?? [];
  const waitingNode = team?.nodes.find((n) =>
    realRun?.nodes.some((state) => state.nodeId === n.id && state.status === 'waiting'),
  );
  const finishLeave = (allowed: boolean) => {
    setLeavePrompt(false);
    leavePromise.current = null;
    const resolve = leaveResolve.current;
    leaveResolve.current = null;

    resolve?.(allowed);
  };
  const navigate = (action: () => void) => {
    void requestLeave().then((allowed) => {
      if (allowed) {
        setFeedback(null);
        action();
      }
    });
  };
  const open = (value: AgentWorkspaceItem) => {
    const draft = copy(value);
    baseline.current = JSON.stringify(draft);
    setEditor(draft);
    setTeamTab('team');
    setRealRun(null);
    setFeedback(null);
    if (draft.kind === 'team') {
      setMemberId(draft.members[0]?.id ?? '');
      setNodeId(draft.nodes[0]?.id ?? '');
    }
  };
  const singles = items.filter((a): a is SingleAgentDraft => a.kind === 'single');
  const newTeam = () => navigate(() => open(newTeamAgent(singles)));
  const back = () => navigate(() => setEditor(null));
  const update = <K extends keyof AgentWorkspaceItem>(key: K, value: AgentWorkspaceItem[K]) =>
    setEditor((previous) => (previous ? { ...previous, [key]: value } : previous));
  const updateTeam = (change: Partial<TeamAgentDraft>) => {
    if (running || busy) {
      setFeedback('请先停止运行，再修改配置。');
      return;
    }
    setRealRun(null);
    setEditor((previous) => (previous?.kind === 'team' ? { ...previous, ...change } : previous));
  };
  const save = async (start = false) => {
    if (!editor || busy) return;
    if (editor.kind === 'single' && !form.current?.reportValidity()) return;
    const invalid = validateAgentDraft(editor);
    if (invalid) {
      setFeedback(invalid);
      return;
    }
    if (!actions?.saveAgentWorkspace) {
      setFeedback('智能体服务不可用。');
      return;
    }
    setBusy(true);
    try {
      const value = await actions.saveAgentWorkspace({ agent: editor });
      onItemsChange(
        items.some((a) => a.id === value.id)
          ? items.map((a) => (a.id === value.id ? value : a))
          : [value, ...items],
      );
      baseline.current = JSON.stringify(value);
      setEditor(value);
      setFeedback('已保存到本机。');
      if (value.kind === 'single') {
        setEditor(null);
        setFilter('all');
        setQuery('');
        if (start) {
          setChat(value);
          setChatPrompt('');
        }
      }
      return value;
    } catch (error) {
      fail(error);
      return;
    } finally {
      setBusy(false);
    }
  };
  const startRun = async () => {
    if (!team || busy || !runPrompt.trim()) return;
    if (dirty) {
      setFeedback('请先保存团队配置，再启动运行。');
      return;
    }
    if (!actions?.startAgentWorkspaceRun) {
      setFeedback('团队执行服务不可用。');
      return;
    }
    setBusy(true);
    try {
      setRealRun(
        await actions.startAgentWorkspaceRun({
          agentId: team.id,
          prompt: runPrompt,
          modelId,
          workspaceId,
        }),
      );
      setFeedback(null);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const changeTab = (tab: TeamTab) => {
    if (running && tab !== 'monitor') {
      setFeedback('请先停止运行，再修改团队或流程。');
      return;
    }
    setTeamTab(tab);
    setFeedback(null);
  };
  const exportConfig = (agent: AgentWorkspaceItem) => {
    const href = URL.createObjectURL(
      new Blob([JSON.stringify({ schemaVersion: 1, preview: false, agent }, null, 2)], {
        type: 'application/json',
      }),
    );
    const a = document.createElement('a');
    a.href = href;
    a.download = 'EvoWork-智能体配置.json';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const teamMember = team?.members.find((m) => m.id === memberId) ?? team?.members[0];
  const node = team?.nodes.find((n) => n.id === nodeId) ?? team?.nodes[0];
  const updateMember = (change: Partial<AgentRole>) => {
    if (team && teamMember)
      updateTeam({
        members: team.members.map((m) => (m.id === teamMember.id ? { ...m, ...change } : m)),
      });
  };
  const updateNode = (change: Partial<AgentFlowNode>) => {
    if (team && node)
      updateTeam({ nodes: team.nodes.map((n) => (n.id === node.id ? { ...n, ...change } : n)) });
  };
  const openConversation = (agent: AgentWorkspaceItem) => {
    setFeedback(null);
    if (agent.kind === 'team') {
      open(agent);
      setTeamTab('monitor');
    } else {
      setChat(agent);
      setChatPrompt('');
    }
  };
  const visibleItems = items.filter(
    (a) =>
      (filter === 'all' || a.kind === filter) &&
      `${a.name} ${a.description} ${capabilityNames(a.skills).join(' ')}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const tabs = [
    { id: 'team', label: '① 组建团队' },
    { id: 'flow', label: '② 流程编排' },
    { id: 'monitor', label: '③ 运行监控' },
  ];

  return (
    <div className="ew-page ew-agents" ref={scroll}>
      <div className="ew-agents-content">
        <div className="ew-agents-topline">
          <span>
            智能体{editor ? ` / ${editor.kind === 'single' ? '单个智能体' : '多智能体协作'}` : ''}
          </span>
          <Badge variant="neutral">本机智能体</Badge>
        </div>
        {editor ? (
          <GhostButton label="返回智能体" onClick={back} icon={renderIcon('arrow-left')} />
        ) : null}
        <header className="ew-agents-heading">
          <div>
            <h1>
              {editor
                ? editor.kind === 'single'
                  ? items.some((a) => a.id === editor.id)
                    ? '编辑智能体'
                    : '创建单个智能体'
                  : editor.name || '创建多智能体协作'
                : '智能体'}
            </h1>
            <p>
              {editor
                ? editor.kind === 'single'
                  ? '先定义角色，再为它配置合适的技能与工具。'
                  : '组建团队、设计分工，让每个角色各展所长。'
                : '让专业能力，成为随时可用的工作伙伴。'}
            </p>
          </div>
          <div className="ew-agents-actions">
            {team ? (
              <>
                <PillButton icon={renderIcon('download')} onClick={() => exportConfig(team)}>
                  导出配置
                </PillButton>
                <PillButton
                  variant="accent"
                  icon={renderIcon('check')}
                  disabled={busy || running}
                  onClick={() => void save()}
                >
                  保存团队
                </PillButton>
              </>
            ) : !editor ? (
              <PillButton
                variant="accent"
                icon={renderIcon('plus')}
                onClick={() => navigate(() => open(newSingleAgent()))}
              >
                新建智能体
              </PillButton>
            ) : (
              <Badge variant="info">单个智能体</Badge>
            )}
          </div>
        </header>
        {feedback ? (
          <p className="ew-agents-feedback" role="status">
            {feedback}
          </p>
        ) : null}
        {!editor ? (
          <>
            <div className="ew-agents-create-grid">
              <button
                type="button"
                className="ew-agents-create-card"
                onClick={() => open(newSingleAgent())}
              >
                <span className="ew-agents-avatar">{renderIcon('agent')}</span>
                <span>
                  <strong>创建单个智能体</strong>
                  <span>
                    定义角色，组合技能与连接器，
                    <br />
                    打造你的专属工作助手。
                  </span>
                </span>
                {renderIcon('arrow-right')}
              </button>
              <button type="button" className="ew-agents-create-card" onClick={newTeam}>
                <span className="ew-agents-avatar" data-tone="info">
                  {renderIcon('team')}
                </span>
                <span>
                  <strong>创建多智能体协作</strong>
                  <span>
                    组建专业团队，编排协作流程，
                    <br />
                    一起完成更复杂的任务。
                  </span>
                </span>
                {renderIcon('arrow-right')}
              </button>
            </div>
            <div className="ew-agents-section-heading">
              <h2>
                我的智能体 <span className="ew-agents-count">{items.length}</span>
              </h2>
              <span>配置保存在本机</span>
            </div>
            <div className="ew-agents-toolbar">
              <SegmentedControl
                variant="light"
                ariaLabel="筛选智能体"
                value={filter}
                onChange={setFilter}
                items={[
                  { id: 'all', label: `全部 ${items.length}` },
                  { id: 'single', label: `单个智能体 ${singles.length}` },
                  { id: 'team', label: `协作团队 ${items.length - singles.length}` },
                ]}
              />
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="搜索名称、描述或技能"
                ariaLabel="搜索智能体"
              />
            </div>
            <div className="ew-agents-grid">
              {visibleItems.map((agent) => (
                <article className="ew-agents-card" key={agent.id} aria-label={agent.name}>
                  <div className="ew-agents-card-heading">
                    <span
                      className="ew-agents-avatar"
                      data-tone={
                        agent.icon === 'pie-chart'
                          ? 'info'
                          : agent.icon === 'shield'
                            ? 'warning'
                            : undefined
                      }
                    >
                      {renderIcon(agent.icon)}
                    </span>
                    <div>
                      <h3>{agent.name}</h3>
                      <p>
                        {agent.kind === 'team'
                          ? `${agent.members.length} 个成员 · 协作团队`
                          : '单个智能体'}
                        {' · 本机配置'}
                      </p>
                    </div>
                    <IconButton
                      label={`管理${agent.name}`}
                      icon={renderIcon('more-horizontal')}
                      onClick={() => {
                        setFeedback(null);
                        setManageTarget(agent);
                      }}
                    />
                  </div>
                  <p className="ew-agents-description">{agent.description}</p>
                  <SkillTags skills={agent.skills} />
                  <div className="ew-agents-card-footer">
                    <span>
                      {agent.kind === 'team' ? '分工协作 · 结果汇总' : '角色、技能与连接器组合'}
                    </span>
                    <div className="ew-agents-actions">
                      <PillButton variant="ghost" onClick={() => open(agent)}>
                        编辑
                      </PillButton>
                      <PillButton
                        variant="accent"
                        trailing={renderIcon('arrow-right')}
                        onClick={() => openConversation(agent)}
                      >
                        {agent.kind === 'team' ? '查看协作' : '开始对话'}
                      </PillButton>
                    </div>
                  </div>
                </article>
              ))}
              {!visibleItems.length ? (
                <EmptyState
                  icon={renderIcon('agent')}
                  title={query ? '没有找到匹配的智能体' : '还没有这类智能体'}
                  hint={query ? '试试其他名称或技能关键词。' : '从定义一个擅长具体工作的角色开始。'}
                  action={
                    <PillButton
                      onClick={() =>
                        query
                          ? setQuery('')
                          : open(filter === 'team' ? newTeamAgent(singles) : newSingleAgent())
                      }
                    >
                      {query ? '清除搜索' : '创建智能体'}
                    </PillButton>
                  }
                />
              ) : null}
            </div>
          </>
        ) : editor.kind === 'single' ? (
          <form
            ref={form}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="ew-agents-editor-layout">
              <div className="ew-agents-stack">
                <AgentPanel
                  step="1"
                  title="专家角色"
                  description="告诉智能体它是谁，以及应该如何完成工作。"
                >
                  <RoleFields
                    role={editor}
                    onChange={(change) => setEditor({ ...editor, ...change })}
                  />
                </AgentPanel>
                <AgentPanel
                  step="2"
                  title="偏好技能"
                  description="选择完成这类工作时需要的能力（可选）。"
                >
                  <CapabilityOptions
                    items={AGENT_SKILLS}
                    selected={editor.skills}
                    onChange={(value) => update('skills', value)}
                    label="偏好技能"
                  />
                </AgentPanel>
                <AgentPanel
                  step="3"
                  title="连接器"
                  description="指定需要使用的工具与数据来源（可选）。"
                >
                  <CapabilityOptions
                    items={AGENT_CONNECTORS}
                    selected={editor.connectors}
                    onChange={(value) => update('connectors', value)}
                    label="连接器"
                  />
                  <p className="ew-agents-note">
                    技能和连接器用于配置工作偏好，实际使用仍受安装、信任与工具审批约束。
                  </p>
                </AgentPanel>
              </div>
              <aside className="ew-agents-panel ew-agents-preview">
                <p className="ew-agents-overline">智能体预览</p>
                <span className="ew-agents-avatar">{renderIcon(editor.icon)}</span>
                <h2>{editor.name || '你的专属智能体'}</h2>
                <p>{editor.description || '角色说明会展示在这里，让你一眼了解它的工作定位。'}</p>
                <SkillTags skills={editor.skills} />
                <div className="ew-agents-preview-rule">
                  <strong>工作配置</strong>
                  <p>
                    {editor.skills.length} 项技能 · {editor.connectors.length} 个连接器
                  </p>
                </div>
                <div className="ew-agents-preview-rule">
                  保存后可在“我的智能体”中继续查看和编辑。
                </div>
              </aside>
            </div>
            <footer className="ew-agents-form-footer">
              <span>{dirty ? '有未保存的修改' : '配置已保存到本机'}</span>
              <div className="ew-agents-actions">
                <PillButton onClick={back}>取消</PillButton>
                <PillButton disabled={busy} onClick={() => void save(true)}>
                  保存并开始对话
                </PillButton>
                <PillButton
                  variant="accent"
                  icon={renderIcon('check')}
                  disabled={busy || running}
                  onClick={() => void save()}
                >
                  保存智能体
                </PillButton>
              </div>
            </footer>
          </form>
        ) : team ? (
          <>
            <div className="ew-agents-tabs">
              <SegmentedControl
                variant="dark"
                ariaLabel="协作配置步骤"
                items={tabs}
                value={teamTab}
                onChange={(id) => changeTab(id as TeamTab)}
              />
            </div>
            {teamTab === 'team' ? (
              <>
                <AgentPanel>
                  <div className="ew-agents-two-col">
                    <label className="ew-agents-field">
                      <span>
                        团队名称 <em>*</em>
                      </span>
                      <input
                        value={team.name}
                        maxLength={40}
                        onChange={(event) => updateTeam({ name: event.target.value })}
                        placeholder="例如：经营分析协作团队"
                      />
                    </label>
                    <label className="ew-agents-field">
                      <span>
                        团队目标 <em>*</em>
                      </span>
                      <input
                        value={team.description}
                        maxLength={500}
                        onChange={(event) => updateTeam({ description: event.target.value })}
                      />
                    </label>
                  </div>
                </AgentPanel>
                <div className="ew-agents-section-heading">
                  <h2>选择协作方式</h2>
                  <span>可在配置过程中调整</span>
                </div>
                <div className="ew-agents-architectures">
                  {AGENT_ARCHITECTURES.map((architecture) => (
                    <button
                      type="button"
                      key={architecture.id}
                      data-selected={team.architecture === architecture.id}
                      aria-pressed={team.architecture === architecture.id}
                      onClick={() => {
                        updateTeam({ architecture: architecture.id });
                        setRealRun(null);
                      }}
                    >
                      {renderIcon(architecture.icon)}
                      <strong>{architecture.name}</strong>
                      <span>{architecture.description}</span>
                    </button>
                  ))}
                </div>
                <div className="ew-agents-team-layout">
                  <aside className="ew-agents-panel">
                    <div className="ew-agents-section-heading">
                      <h3>团队成员</h3>
                      <span className="ew-agents-count">{team.members.length}</span>
                    </div>
                    <div className="ew-agents-members">
                      {team.members.map((member) => (
                        <button
                          type="button"
                          key={member.id}
                          data-selected={member.id === teamMember?.id}
                          aria-pressed={member.id === teamMember?.id}
                          onClick={() => setMemberId(member.id)}
                        >
                          <span className="ew-agents-avatar">
                            {renderIcon(member.lead ? 'project' : 'agent')}
                          </span>
                          <span>
                            <strong>{member.name || '未命名成员'}</strong>
                            <small>{member.lead ? '主控 · 最终交付' : '专业执行智能体'}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="ew-agents-add-member">
                      <PillButton
                        icon={renderIcon('plus')}
                        onClick={() => {
                          setPicked([]);
                          setPicking(true);
                        }}
                      >
                        添加专业智能体
                      </PillButton>
                    </div>
                    <p className="ew-agents-note">
                      先明确每个成员的职责，再配置必要的工具与输出要求。
                    </p>
                  </aside>
                  {teamMember ? (
                    <AgentPanel
                      title={teamMember.name || '成员配置'}
                      action={
                        teamMember.lead ? (
                          <Badge variant="success">主控 · 必选</Badge>
                        ) : (
                          <PillButton
                            variant="ghost"
                            onClick={() => {
                              if (team.nodes.some((n) => n.memberId === teamMember.id)) {
                                setFeedback('该成员负责流程节点，请先在流程编排中调整执行角色。');
                                return;
                              }
                              updateTeam({
                                members: team.members.filter((m) => m.id !== teamMember.id),
                              });
                              setMemberId(team.members[0]!.id);
                            }}
                          >
                            移除成员
                          </PillButton>
                        )
                      }
                    >
                      <RoleFields role={teamMember} onChange={updateMember} member />
                      <CapabilityOptions
                        items={AGENT_SKILLS}
                        selected={teamMember.skills}
                        onChange={(skills) => updateMember({ skills })}
                        label="成员偏好技能"
                      />
                      <CapabilityOptions
                        items={AGENT_CONNECTORS}
                        selected={teamMember.connectors}
                        onChange={(connectors) => updateMember({ connectors })}
                        label="成员连接器"
                      />
                    </AgentPanel>
                  ) : null}
                </div>
              </>
            ) : teamTab === 'flow' ? (
              <>
                <div className="ew-agents-section-heading">
                  <div>
                    <h2>协作流程</h2>
                    <p>
                      {AGENT_ARCHITECTURES.find((a) => a.id === team.architecture)?.name} ·
                      点击节点编辑配置
                    </p>
                  </div>
                  <PillButton
                    icon={renderIcon('plus')}
                    disabled={team.nodes.length >= 20}
                    disabledReason="最多支持 20 个节点"
                    onClick={() => {
                      const added: AgentFlowNode = {
                        id: crypto.randomUUID(),
                        name: '新增处理节点',
                        memberId: team.members[0]!.id,
                        input: '',
                        output: '',
                        condition: 'success',
                      };
                      const nodes = [...team.nodes];
                      nodes.splice(Math.max(0, nodes.length - 1), 0, added);
                      updateTeam({ nodes });
                      setNodeId(added.id);
                      setRealRun(null);
                    }}
                  >
                    添加节点
                  </PillButton>
                </div>
                <div className="ew-agents-flow-layout">
                  <section className="ew-agents-canvas" aria-label="协作流程画布">
                    <div className="ew-agents-canvas-heading">
                      <span>工作流画布</span>
                      <span>{team.nodes.length} 个节点 · 自动排列</span>
                    </div>
                    <div className="ew-agents-flow-stack">
                      <span className="ew-agents-flow-pill">用户提交任务</span>
                      {batches.map((batch, index) => (
                        <div className="ew-agents-flow-group" key={index}>
                          <span className="ew-agents-flow-line" />
                          {batch.length > 1 ? <p>并行执行 · 全部完成后汇合</p> : null}
                          <div className="ew-agents-flow-batch" data-parallel={batch.length > 1}>
                            {batch.map((n) => (
                              <button
                                type="button"
                                className="ew-agents-flow-node"
                                key={n.id}
                                data-selected={node?.id === n.id}
                                aria-pressed={node?.id === n.id}
                                onClick={() => setNodeId(n.id)}
                              >
                                <span className="ew-agents-avatar">
                                  {renderIcon(
                                    team.members.find((m) => m.id === n.memberId)?.lead
                                      ? 'project'
                                      : 'agent',
                                  )}
                                </span>
                                <span>
                                  <strong>{n.name || '未命名节点'}</strong>
                                  <small>
                                    {team.members.find((m) => m.id === n.memberId)?.name}
                                  </small>
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                      <span className="ew-agents-flow-line" />
                      <span className="ew-agents-flow-pill">完成并交付</span>
                    </div>
                  </section>
                  {node ? (
                    <AgentPanel
                      title="节点配置"
                      action={
                        <Badge variant="neutral">
                          {team.nodes.indexOf(node) + 1} / {team.nodes.length}
                        </Badge>
                      }
                    >
                      <label className="ew-agents-field">
                        <span>
                          节点名称 <em>*</em>
                        </span>
                        <input
                          value={node.name}
                          maxLength={60}
                          onChange={(event) => updateNode({ name: event.target.value })}
                        />
                      </label>
                      <label className="ew-agents-field">
                        <span>执行角色</span>
                        <select
                          value={node.memberId}
                          onChange={(event) => updateNode({ memberId: event.target.value })}
                        >
                          {team.members.map((m) => (
                            <option value={m.id} key={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="ew-agents-field">
                        <span>输入 / 任务说明</span>
                        <textarea
                          value={node.input}
                          maxLength={5000}
                          onChange={(event) => updateNode({ input: event.target.value })}
                        />
                      </label>
                      <label className="ew-agents-field">
                        <span>输出要求</span>
                        <textarea
                          value={node.output}
                          maxLength={5000}
                          onChange={(event) => updateNode({ output: event.target.value })}
                        />
                      </label>
                      <label className="ew-agents-field">
                        <span>完成条件</span>
                        <select
                          value={node.condition}
                          onChange={(event) =>
                            updateNode({
                              condition: event.target.value as AgentFlowNode['condition'],
                            })
                          }
                        >
                          <option value="success">执行成功后继续</option>
                          <option value="review">复核输出后继续（人工确认）</option>
                          <option value="human">等待人工确认</option>
                        </select>
                      </label>
                      <PillButton
                        variant="danger"
                        disabled={team.nodes.length <= 1}
                        disabledReason="至少保留一个流程节点"
                        onClick={() => {
                          const nodes = team.nodes.filter((n) => n.id !== node.id);
                          updateTeam({ nodes });
                          setNodeId(nodes[0]?.id ?? '');
                          setRealRun(null);
                        }}
                      >
                        删除节点
                      </PillButton>
                    </AgentPanel>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="ew-agents-section-heading">
                  <div>
                    <h2>
                      协作运行 <Badge variant="info">真实任务</Badge>
                    </h2>
                    <p>按已保存的成员和流程执行；节点审批与详细记录可在任务中查看。</p>
                  </div>
                  <div className="ew-agents-actions">
                    <PillButton
                      disabled={!running || busy}
                      disabledReason="当前没有运行中的任务"
                      onClick={() => void decide('stop')}
                    >
                      停止
                    </PillButton>
                    <PillButton
                      variant="accent"
                      icon={renderIcon('play')}
                      disabled={running || busy || !runPrompt.trim() || dirty}
                      disabledReason="请先保存配置、填写需求，并等待当前运行结束"
                      onClick={() => void startRun()}
                    >
                      开始运行
                    </PillButton>
                  </div>
                </div>
                <label className="ew-agents-field">
                  <span>团队任务需求</span>
                  <textarea
                    aria-label="团队任务需求"
                    value={runPrompt}
                    disabled={running || busy}
                    maxLength={16000}
                    onChange={(event) => setRunPrompt(event.target.value)}
                  />
                </label>
                <div className="ew-agents-metrics">
                  <Metric label="本次任务状态" value={RUN_COPY[run.status]} hint="本机真实任务" />
                  <Metric
                    label="执行节点"
                    value={`${run.completed.length} / ${team.nodes.length}`}
                    hint="按当前流程统计"
                  />
                  <Metric
                    label="参与智能体"
                    value={String(team.members.length)}
                    hint="主控与专业成员"
                  />
                  <Metric
                    label="人工确认"
                    value={`${run.confirmed.length} / ${team.nodes.filter((n) => n.condition === 'human').length}`}
                    hint="由节点完成条件决定"
                  />
                </div>
                <div className="ew-agents-monitor-layout">
                  <AgentPanel
                    title="执行进度"
                    action={
                      <Badge variant={run.status === 'completed' ? 'success' : 'neutral'}>
                        {RUN_COPY[run.status]}
                      </Badge>
                    }
                  >
                    <div>
                      {team.nodes.map((n, index) => {
                        const completed = run.completed.includes(n.id);
                        const active = running && currentBatch.some((a) => a.id === n.id);
                        return (
                          <div
                            className="ew-agents-run-row"
                            key={n.id}
                            data-state={completed ? 'done' : active ? 'running' : 'idle'}
                          >
                            <span className="ew-agents-run-index">
                              {completed ? renderIcon('check') : index + 1}
                            </span>
                            <div>
                              <strong>{n.name}</strong>
                              <small>{team.members.find((m) => m.id === n.memberId)?.name}</small>
                              {realRun?.nodes.find((state) => state.nodeId === n.id)?.threadId ? (
                                <PillButton
                                  onClick={() =>
                                    onOpenTask?.(
                                      realRun.nodes.find((state) => state.nodeId === n.id)!
                                        .threadId!,
                                    )
                                  }
                                >
                                  查看节点任务
                                </PillButton>
                              ) : null}
                              {realRun?.nodes.find((state) => state.nodeId === n.id)?.output ? (
                                <details>
                                  <summary>节点输出</summary>
                                  <pre>
                                    {realRun.nodes.find((state) => state.nodeId === n.id)!.output}
                                  </pre>
                                </details>
                              ) : null}
                            </div>
                            <span>
                              {completed
                                ? '已完成'
                                : run.status === 'waiting' && waitingNode?.id === n.id
                                  ? '等待确认'
                                  : active
                                    ? '运行中'
                                    : run.status === 'stopped'
                                      ? '已停止'
                                      : '等待中'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {run.status === 'waiting' && waitingNode ? (
                      <div className="ew-agents-confirm-run">
                        <strong>流程等待人工确认</strong>
                        <p>{waitingNode.name}已提交真实输出，请复核后继续。</p>
                        <pre>{realRun?.nodes.find((n) => n.nodeId === waitingNode.id)?.output}</pre>
                        <div className="ew-agents-actions">
                          <PillButton
                            variant="accent"
                            onClick={() => void decide('confirm', waitingNode.id)}
                          >
                            确认并继续
                          </PillButton>
                          <PillButton onClick={() => void decide('stop')}>拒绝并停止</PillButton>
                        </div>
                      </div>
                    ) : null}
                  </AgentPanel>
                  <AgentPanel title="协作日志" action={<Badge variant="neutral">执行记录</Badge>}>
                    <div className="ew-agents-log" role="log" aria-label="协作运行日志">
                      {run.logs.length ? (
                        run.logs.map((line, index) => (
                          <p key={index}>
                            <span>{String(index + 1).padStart(2, '0')}</span>
                            {line}
                          </p>
                        ))
                      ) : (
                        <p>等待启动。填写任务需求后开始执行。</p>
                      )}
                    </div>
                  </AgentPanel>
                </div>
              </>
            )}
            <footer className="ew-agents-form-footer">
              <span>
                {teamTab === 'team'
                  ? '成员与节点配置将随团队一起保存。'
                  : teamTab === 'flow'
                    ? '调整会实时显示在画布上，保存后生效。'
                    : '以上进度来自真实节点任务。离开此页不会停止后台执行。'}
              </span>
              <div className="ew-agents-actions">
                {teamTab !== 'team' ? (
                  <PillButton onClick={() => changeTab(teamTab === 'monitor' ? 'flow' : 'team')}>
                    返回{teamTab === 'monitor' ? '流程编排' : '团队配置'}
                  </PillButton>
                ) : null}
                {teamTab !== 'monitor' ? (
                  <PillButton
                    variant="accent"
                    trailing={renderIcon('arrow-right')}
                    onClick={() => changeTab(teamTab === 'team' ? 'flow' : 'monitor')}
                  >
                    {teamTab === 'team' ? '下一步：流程编排' : '查看运行监控'}
                  </PillButton>
                ) : null}
              </div>
            </footer>
          </>
        ) : null}
        <p className="ew-agents-footnote">
          {renderIcon('shield')}配置保存在本机；任务沿用模型、技能安装状态与工具审批设置。
        </p>
      </div>
      {manageTarget ? (
        <Dialog
          title={`管理${manageTarget.name}`}
          confirmLabel="编辑配置"
          onCancel={() => setManageTarget(null)}
          onConfirm={() => {
            open(manageTarget);
            setManageTarget(null);
          }}
        >
          <p>查看或管理这个{manageTarget.kind === 'team' ? '协作团队' : '智能体'}的配置。</p>
          <div className="ew-agents-dialog-actions">
            <PillButton icon={renderIcon('download')} onClick={() => exportConfig(manageTarget)}>
              导出 JSON 配置
            </PillButton>
            <PillButton
              variant="danger"
              icon={renderIcon('trash')}
              onClick={() => {
                setDeleteTarget(manageTarget);
                setManageTarget(null);
              }}
            >
              删除配置
            </PillButton>
          </div>
        </Dialog>
      ) : null}
      {deleteTarget ? (
        <Dialog
          title={`删除${deleteTarget.name}？`}
          variant="danger"
          confirmLabel="确认删除"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            if (busy || !actions?.deleteAgentWorkspace || !deleteTarget.revision) return;
            setBusy(true);
            void actions
              .deleteAgentWorkspace({ id: deleteTarget.id, revision: deleteTarget.revision })
              .then(() => {
                onItemsChange(items.filter((a) => a.id !== deleteTarget.id));
                setDeleteTarget(null);
                setFeedback('已删除本机配置。');
              })
              .catch(fail)
              .finally(() => setBusy(false));
          }}
        >
          {feedback ? <p role="alert">{feedback}</p> : null}
          <p>删除本机配置，已保存团队中的成员快照和任务历史不受影响。</p>
        </Dialog>
      ) : null}
      {picking && team ? (
        <Dialog
          title="添加专业智能体"
          confirmLabel="添加到团队"
          confirmDisabled={!picked.length}
          onCancel={() => setPicking(false)}
          onConfirm={() => {
            const added = singles.filter((a) => picked.includes(a.id)).map(memberFromAgent);
            updateTeam({ members: [...team.members, ...added] });
            setMemberId(added[0]?.id ?? memberId);
            setPicking(false);
          }}
        >
          <p>选择一个或多个已有智能体加入团队。</p>
          <div className="ew-agents-picker">
            {singles
              .filter((a) => !team.members.some((m) => m.sourceAgentId === a.id))
              .map((a) => (
                <label key={a.id}>
                  <span className="ew-agents-avatar">{renderIcon(a.icon)}</span>
                  <span>
                    <strong>{a.name}</strong>
                    <small>{capabilityNames(a.skills).join(' · ')}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={picked.includes(a.id)}
                    onChange={(event) =>
                      setPicked((previous) =>
                        event.target.checked
                          ? [...previous, a.id]
                          : previous.filter((id) => id !== a.id),
                      )
                    }
                  />
                </label>
              ))}
            {singles.every((a) => team.members.some((m) => m.sourceAgentId === a.id)) ? (
              <p>所有可用智能体均已加入。可先创建新的单个智能体。</p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
      {chat ? (
        <Dialog
          title={`与${chat.name}对话`}
          confirmLabel="开始任务"
          cancelLabel="关闭"
          closable
          confirmDisabled={busy || !chatPrompt.trim()}
          onCancel={() => {
            if (!busy) setChat(null);
          }}
          onConfirm={() => {
            if (busy || !onConversation) return;
            setBusy(true);
            void onConversation(chat.id, chatPrompt)
              .then(() => setChat(null))
              .catch(fail)
              .finally(() => setBusy(false));
          }}
        >
          {feedback ? <p role="alert">{feedback}</p> : null}
          <p className="ew-agents-note">
            使用已保存的角色配置创建真实任务，沿用当前选择的模型与项目。
          </p>
          <label className="ew-agents-field">
            <span>任务需求</span>
            <textarea
              value={chatPrompt}
              maxLength={16000}
              onChange={(event) => setChatPrompt(event.target.value)}
              placeholder="告诉它你想完成什么工作…"
            />
          </label>
        </Dialog>
      ) : null}
      {leavePrompt ? (
        <Dialog
          title="离开当前配置？"
          confirmLabel="放弃并离开"
          cancelLabel="继续编辑"
          onCancel={() => finishLeave(false)}
          onConfirm={() => finishLeave(true)}
        >
          <p>
            {running ? '离开后后台任务继续运行，可返回此页查看进度。' : ''}
            {dirty ? '当前修改还没有保存，离开后将丢弃这些修改。' : ''}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function AgentPanel({
  step,
  title,
  description,
  action,
  children,
}: {
  readonly step?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly action?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="ew-agents-panel">
      {title ? (
        <div className="ew-agents-panel-heading">
          {step ? <span className="ew-agents-step">{step}</span> : null}
          <h2>{title}</h2>
          {action}
        </div>
      ) : null}
      {description ? <p className="ew-agents-panel-description">{description}</p> : null}
      {children}
    </section>
  );
}
function SkillTags({ skills }: { readonly skills: readonly string[] }) {
  return (
    <div className="ew-agents-tags">
      {skills.length ? (
        capabilityNames(skills).map((name, index) => (
          <span key={`${skills[index]}-${index}`}>{name}</span>
        ))
      ) : (
        <span>未选择技能</span>
      )}
    </div>
  );
}
function RoleFields({
  role,
  onChange,
  member = false,
}: {
  readonly role: AgentRole;
  readonly onChange: (change: Partial<AgentRole>) => void;
  readonly member?: boolean | undefined;
}) {
  return (
    <>
      <label className="ew-agents-field">
        <span>
          {member ? '角色名称' : '智能体名称'} <em>*</em>
        </span>
        <input
          required
          maxLength={40}
          value={role.name}
          placeholder="例如：经营分析助手"
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label className="ew-agents-field">
        <span>
          {member ? '职责说明' : '角色说明'} <em>*</em>
        </span>
        <textarea
          required
          maxLength={500}
          value={role.description}
          placeholder="描述专业领域、服务对象和擅长解决的问题。"
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>
      <label className="ew-agents-field">
        <span>
          {member ? '专属工作指令' : '工作指令'} <em>*</em>
        </span>
        <textarea
          required
          className="ew-agents-instructions"
          maxLength={12000}
          value={role.instructions}
          placeholder="明确工作步骤、输出要求与注意事项。"
          onChange={(event) => onChange({ instructions: event.target.value })}
        />
        <small>工作指令定义工作方式，下方技能提供具体能力。</small>
      </label>
    </>
  );
}
function CapabilityOptions({
  items,
  selected,
  onChange,
  label,
}: {
  readonly items: readonly AgentCapability[];
  readonly selected: readonly string[];
  readonly onChange: (ids: string[]) => void;
  readonly label: string;
}) {
  return (
    <fieldset className="ew-agents-capabilities">
      <legend>{label}</legend>
      <div>
        {items.map((item) => (
          <label key={item.id} data-selected={selected.includes(item.id)}>
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, item.id]
                    : selected.filter((id) => id !== item.id),
                )
              }
            />
            <span>
              <strong>{item.name}</strong>
              <small>{item.description}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function Metric({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}) {
  return (
    <div className="ew-agents-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}
