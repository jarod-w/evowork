import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AGENTS,
  CONNECTIONS,
  PATH,
  SEED_MODELS,
  SEED_POLICY,
  SEED_PROVIDERS,
  SEED_SOURCES,
  TOOL_GRANTS,
  canApprove,
  guard,
  parseRole,
  persona,
  usableModels,
  type AuditRow,
  type CatalogModel,
  type ChangeId,
  type KnowledgeSource,
  type PolicyBody,
  type PolicyDraft,
  type PolicyPack,
  type Provider,
  type Role,
  type SpaceId,
  type TaskDecision,
} from './model';

export type ConsoleState = {
  spaceId: SpaceId;
  egressStopped: boolean;
  selfService: boolean;
  language: 'zh-CN' | 'en';
  notify: boolean;
  warnPercent: number;
  aliases: { reasoning: string; fast: string };
  providers: Provider[];
  models: CatalogModel[];
  sources: KnowledgeSource[];
  deptAgentsOff: string[];
  granted: Record<string, boolean>;
  hiddenMemories: string[];
  signedOut: string[];
  taskDecisions: Record<string, TaskDecision>;
  taskNotes: Record<string, string>;
  stoppedAgents: string[];
  revokedTools: string[];
  changes: Record<ChangeId, 'pending' | 'approved'>;
  nudged: boolean;
  auditExtra: AuditRow[];
  packs: PolicyPack[];
  policyDraft: PolicyDraft | null;
};

function freshState(): ConsoleState {
  return {
    spaceId: 'sea',
    egressStopped: false,
    selfService: true,
    language: 'zh-CN',
    notify: true,
    warnPercent: 80,
    aliases: { reasoning: 'sonnet', fast: 'haiku' },
    providers: SEED_PROVIDERS.map((item) => ({ ...item })),
    models: SEED_MODELS.map((item) => ({ ...item })),
    sources: SEED_SOURCES.map((item) => ({ ...item })),
    deptAgentsOff: [],
    granted: { outlook: true, sharepoint: true, slack: false },
    hiddenMemories: [],
    signedOut: [],
    taskDecisions: {},
    taskNotes: {},
    stoppedAgents: [],
    revokedTools: [],
    changes: { publish: 'pending', egress: 'pending' },
    nudged: false,
    auditExtra: [],
    packs: [{ ...SEED_POLICY }],
    policyDraft: null,
  };
}

type LocationState = { pathname: string; query: string; role: Role };

function readLocation(): LocationState {
  const url = new URL(window.location.href);
  return {
    pathname: url.pathname,
    query: url.searchParams.get('q') ?? '',
    role: parseRole(url.search, url.pathname),
  };
}

type ConsoleValue = ConsoleState & {
  pathname: string;
  query: string;
  role: Role;
  navigate: (pathname: string, query?: string) => void;
  setRole: (role: Role) => void;
  toast: (text: string) => void;
  toasts: { id: number; text: string }[];
  setSpace: (spaceId: SpaceId) => void;
  setAlias: (key: 'reasoning' | 'fast', modelId: string) => void;
  saveProvider: (draft: Provider) => boolean;
  setProviderEnabled: (id: string, enabled: boolean) => void;
  testProvider: (id: string) => void;
  saveModel: (draft: CatalogModel) => boolean;
  setModelEnabled: (id: string, enabled: boolean) => void;
  saveSource: (draft: {
    id: string;
    name: string;
    level: '内部' | '机密';
    note: string;
  }) => boolean;
  setSourceEnabled: (id: string, enabled: boolean) => void;
  retrySource: (id: string) => void;
  retryFailedSources: () => void;
  toggleDeptAgent: (id: string) => void;
  setWarnPercent: (value: number) => void;
  setSelfService: (on: boolean) => void;
  setLanguage: (language: 'zh-CN' | 'en') => void;
  setNotify: (on: boolean) => void;
  grantConnection: (id: string, on: boolean) => void;
  deleteMemory: (id: string) => void;
  signOutSession: (id: string) => void;
  decideTask: (taskId: string, decision: TaskDecision, note?: string) => void;
  killEgress: () => void;
  restoreEgress: () => void;
  stopAgent: (id: string) => void;
  toggleTool: (id: string) => void;
  approveChange: (id: ChangeId) => void;
  nudgeDevices: () => void;
  savePolicyDraft: (body: PolicyBody) => boolean;
  discardPolicyDraft: (mode: 'drop' | 'return') => void;
  signPolicy: () => void;
  reset: () => void;
};

const Ctx = createContext<ConsoleValue | null>(null);

export function useConsole() {
  const value = useContext(Ctx);
  if (!value) throw new Error('ConsoleProvider missing');
  return value;
}

function stamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConsoleState>(freshState);
  const [loc, setLoc] = useState<LocationState>(readLocation);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const seq = useRef(1);
  const stateRef = useRef(state);
  stateRef.current = state;

  const toast = useCallback((text: string) => {
    const id = seq.current++;
    setToasts((items) => [...items, { id, text }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 3400);
  }, []);

  const writeUrl = useCallback((pathname: string, role: Role, query: string, replace: boolean) => {
    const params = new URLSearchParams();
    params.set('as', role);
    if (query) params.set('q', query);
    const next = `${pathname}?${params.toString()}`;
    if (replace) window.history.replaceState({}, '', next);
    else window.history.pushState({}, '', next);
    setLoc({ pathname, query, role });
  }, []);

  const navigate = useCallback(
    (pathname: string, query = '') => {
      writeUrl(pathname, loc.role, query, false);
    },
    [loc.role, writeUrl],
  );

  const setRole = useCallback(
    (role: Role) => {
      writeUrl(
        role === 'user' ? PATH.home : role === 'dept' ? PATH.dept : PATH.admin,
        role,
        '',
        false,
      );
    },
    [writeUrl],
  );

  useEffect(() => {
    const onPop = () => setLoc(readLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('as')) {
      writeUrl(loc.pathname, loc.role, loc.query, true);
    }
  }, [loc.pathname, loc.query, loc.role, writeUrl]);

  useEffect(() => {
    const next = guard(loc.role, loc.pathname, state.selfService);
    if (next !== loc.pathname) writeUrl(next, loc.role, '', true);
  }, [loc.pathname, loc.role, state.selfService, writeUrl]);

  const log = useCallback((row: Omit<AuditRow, 'id' | 'time' | 'space'>) => {
    const space = stateRef.current.spaceId === 'jp' ? '日本子公司' : '东南亚总部';
    const entry: AuditRow = { ...row, id: `live-${seq.current++}`, time: stamp(), space };
    setState((current) => ({ ...current, auditExtra: [entry, ...current.auditExtra] }));
  }, []);

  const api = useMemo<ConsoleValue>(() => {
    const who = persona(loc.role);
    return {
      ...state,
      pathname: loc.pathname,
      query: loc.query,
      role: loc.role,
      navigate,
      setRole,
      toast,
      toasts,
      setSpace: (spaceId) => setState((current) => ({ ...current, spaceId })),
      setAlias: (key, modelId) => {
        const allowed = usableModels(stateRef.current.models, stateRef.current.providers);
        if (!allowed.some((item) => item.id === modelId)) {
          toast('别名只能映射到已启用、已评估、且提供商可用的模型。');
          return;
        }
        setState((current) => ({ ...current, aliases: { ...current.aliases, [key]: modelId } }));
        log({
          actor: who.name,
          action: '修改模型别名',
          target: key === 'fast' ? '快速' : '高推理',
          result: '成功',
          trace: 'tr-alias',
        });
        toast('别名已改。成员侧仍只看见别名，看不见厂商。');
      },
      saveProvider: (draft) => {
        const name = draft.name.trim();
        const endpoint = draft.endpoint.trim();
        const vaultRef = draft.auth === 'iam' ? '' : draft.vaultRef.trim();
        if (!name || !endpoint) {
          toast('名称和端点都要填写。');
          return false;
        }
        if (draft.auth === 'vault' && !vaultRef) {
          toast('需要密钥时只填保险库引用，不要把密钥粘贴到页面上。');
          return false;
        }
        if (draft.assessed && (!draft.assessor.trim() || !draft.assessedOn)) {
          toast('标记已评估时要填写评估人和日期。');
          return false;
        }
        const id = draft.id || `prov-${seq.current++}`;
        const next: Provider = {
          ...draft,
          id,
          name,
          endpoint,
          vaultRef,
          assessor: draft.assessor.trim(),
        };
        const existed = stateRef.current.providers.some((item) => item.id === id);
        setState((current) => ({
          ...current,
          providers: existed
            ? current.providers.map((item) => (item.id === id ? next : item))
            : [...current.providers, next],
        }));
        log({
          actor: who.name,
          action: existed ? '修改提供商' : '新增提供商',
          target: name,
          result: next.assessed ? '已评估' : '未评估',
          trace: 'tr-provider',
        });
        toast(next.assessed ? '提供商已保存。' : '提供商已保存。未评估的提供商不能进入别名路由。');
        return true;
      },
      setProviderEnabled: (id, enabled) => {
        const name = stateRef.current.providers.find((item) => item.id === id)?.name ?? id;
        setState((current) => ({
          ...current,
          providers: current.providers.map((item) =>
            item.id === id ? { ...item, enabled } : item,
          ),
        }));
        log({
          actor: who.name,
          action: enabled ? '启用提供商' : '停用提供商',
          target: name,
          result: '成功',
          trace: 'tr-provider',
        });
        toast(enabled ? `${name} 已启用。` : `${name} 已停用。它下面的模型不会再被别名选中。`);
      },
      testProvider: (id) => {
        const provider = stateRef.current.providers.find((item) => item.id === id);
        if (!provider) return;
        if (!provider.enabled) {
          toast('已停用的提供商不能做连通性测试。');
          return;
        }
        if (!provider.endpoint.trim()) {
          toast('先填写端点，再测试。');
          return;
        }
        log({
          actor: who.name,
          action: '测试提供商',
          target: provider.name,
          result: '已记录',
          trace: 'tr-provider',
        });
        toast('原型不发起真实连接。这次连通性检查记为可达。');
      },
      saveModel: (draft) => {
        const name = draft.name.trim();
        const version = draft.version.trim();
        if (!name || !version || !draft.providerId) {
          toast('名称、版本和提供商都要填写。');
          return false;
        }
        if (!Number.isFinite(draft.context) || draft.context <= 0) {
          toast('上下文长度要是大于 0 的数字。');
          return false;
        }
        if (draft.assessed && (!draft.assessor.trim() || !draft.assessedOn)) {
          toast('标记已评估时要填写评估人和日期。');
          return false;
        }
        const provider = stateRef.current.providers.find((item) => item.id === draft.providerId);
        if (!provider) {
          toast('先选择一个提供商。');
          return false;
        }
        const id = draft.id || `model-${seq.current++}`;
        const next: CatalogModel = { ...draft, id, name, version, assessor: draft.assessor.trim() };
        const existed = stateRef.current.models.some((item) => item.id === id);
        setState((current) => ({
          ...current,
          models: existed
            ? current.models.map((item) => (item.id === id ? next : item))
            : [...current.models, next],
        }));
        log({
          actor: who.name,
          action: existed ? '修改模型' : '新增模型',
          target: name,
          result: next.assessed ? '已评估' : '未评估',
          trace: 'tr-model',
        });
        toast(
          next.assessed && next.enabled
            ? '模型已保存，可以映射到别名。'
            : '模型已保存。未评估或未启用的模型不会进入别名路由。',
        );
        return true;
      },
      setModelEnabled: (id, enabled) => {
        const name = stateRef.current.models.find((item) => item.id === id)?.name ?? id;
        setState((current) => ({
          ...current,
          models: current.models.map((item) => (item.id === id ? { ...item, enabled } : item)),
        }));
        log({
          actor: who.name,
          action: enabled ? '启用模型' : '停用模型',
          target: name,
          result: '成功',
          trace: 'tr-model',
        });
        toast(enabled ? `${name} 已启用。` : `${name} 已停用。指向它的别名需要改到其他模型。`);
      },
      setWarnPercent: (value) => {
        setState((current) => ({ ...current, warnPercent: value }));
        toast(`提醒线已改为 ${value}%`);
      },
      setSelfService: (on) => {
        setState((current) => ({ ...current, selfService: on }));
        log({
          actor: who.name,
          action: on ? '打开记忆自助' : '关闭记忆自助',
          target: '成员网页',
          result: '成功',
          trace: 'tr-memory',
        });
        toast(on ? '成员可以查看自己的记忆。' : '成员网页里不再出现「我的记忆」。');
      },
      setLanguage: (language) => setState((current) => ({ ...current, language })),
      setNotify: (on) => setState((current) => ({ ...current, notify: on })),
      grantConnection: (id, on) => {
        setState((current) => ({ ...current, granted: { ...current.granted, [id]: on } }));
        const name = CONNECTIONS.find((item) => item.id === id)?.name ?? id;
        toast(on ? `${name} 将在客户端完成授权。` : `已撤销 ${name}。`);
      },
      deleteMemory: (id) => {
        setState((current) => ({ ...current, hiddenMemories: [...current.hiddenMemories, id] }));
        log({ actor: '林可', action: '删除记忆', target: id, result: '成功', trace: 'tr-mem-del' });
        toast('这条记忆已从你的列表移除。');
      },
      signOutSession: (id) => {
        setState((current) => ({ ...current, signedOut: [...current.signedOut, id] }));
        toast('该会话已退出。');
      },
      decideTask: (taskId, decision, note) => {
        const outlookRevoked = stateRef.current.revokedTools.includes('outlook');
        const noGrant = stateRef.current.granted.outlook === false;
        if (decision !== 'rejected' && stateRef.current.egressStopped) {
          toast('管理员已停止全部外发，这条发送不能批准。');
          return;
        }
        if (decision !== 'rejected' && outlookRevoked) {
          toast('管理员未授权这个 Agent 发送邮件。');
          return;
        }
        if (decision !== 'rejected' && noGrant) {
          toast('你已撤销 Outlook，无法批准发送。');
          return;
        }
        setState((current) => ({
          ...current,
          taskDecisions: { ...current.taskDecisions, [taskId]: decision },
          taskNotes: note ? { ...current.taskNotes, [taskId]: note } : current.taskNotes,
        }));
        const result =
          decision === 'rejected' ? '已拒绝' : decision === 'edited' ? '修改后批准' : '已批准';
        log({ actor: '林可', action: '审批发送', target: '经营会纪要', result, trace: 'tr-20481' });
        toast(
          decision === 'rejected'
            ? '已拒绝。客户端不会发送。'
            : '已记下你的决定。发送仍由你的电脑执行。',
        );
      },
      killEgress: () => {
        setState((current) => ({ ...current, egressStopped: true }));
        log({
          actor: who.name,
          action: '紧急停止',
          target: '全部外发',
          result: '已停止',
          trace: 'tr-kill',
        });
        toast('全部外发已停止。');
      },
      restoreEgress: () => {
        setState((current) => ({ ...current, egressStopped: false }));
        log({
          actor: who.name,
          action: '恢复外发',
          target: '全部外发',
          result: '已恢复',
          trace: 'tr-kill',
        });
        toast('外发已恢复。');
      },
      stopAgent: (id) => {
        setState((current) => ({
          ...current,
          stoppedAgents: current.stoppedAgents.includes(id)
            ? current.stoppedAgents
            : [...current.stoppedAgents, id],
        }));
        log({
          actor: who.name,
          action: '停止 Agent',
          target: id,
          result: '已停止',
          trace: 'tr-agent-stop',
        });
        toast('这个 Agent 已停用。正在跑的任务会在下一步被拒绝。');
      },
      toggleTool: (id) => {
        setState((current) => {
          const has = current.revokedTools.includes(id);
          return {
            ...current,
            revokedTools: has
              ? current.revokedTools.filter((item) => item !== id)
              : [...current.revokedTools, id],
          };
        });
        const tool = TOOL_GRANTS.find((item) => item.id === id);
        log({
          actor: who.name,
          action: '调整工具授权',
          target: tool?.tool ?? id,
          result: '成功',
          trace: 'tr-tool',
        });
      },
      approveChange: (id) => {
        if (!canApprove(loc.role, id)) {
          toast(id === 'publish' ? '发布要由安全管理员审批。' : '提交人不能审批自己的出口变更。');
          return;
        }
        setState((current) => ({ ...current, changes: { ...current.changes, [id]: 'approved' } }));
        log({
          actor: who.name,
          action: '批准变更',
          target: id === 'publish' ? '合同条款审阅 v3' : 'api.slack.com',
          result: '已批准',
          trace: id === 'publish' ? 'tr-20302' : 'tr-20311',
        });
        toast(
          id === 'publish' ? '已发布。林可的工作台现在能看到这个 Agent。' : '已加入出口白名单。',
        );
      },
      saveSource: (draft) => {
        const name = draft.name.trim();
        if (!name) {
          toast('要填写数据源名称。');
          return false;
        }
        const id = draft.id || `src-${seq.current++}`;
        const existing = stateRef.current.sources.find((item) => item.id === id);
        const next: KnowledgeSource = existing
          ? { ...existing, name, level: draft.level, note: draft.note.trim() || existing.note }
          : {
              id,
              name,
              dept: '财务共享中心',
              state: '同步成功',
              when: '刚刚',
              level: draft.level,
              note: draft.note.trim() || '部门管理员添加',
              enabled: true,
            };
        setState((current) => ({
          ...current,
          sources: existing
            ? current.sources.map((item) => (item.id === id ? next : item))
            : [...current.sources, next],
        }));
        log({
          actor: who.name,
          action: existing ? '修改部门知识库' : '新增部门知识库',
          target: name,
          result: '成功',
          trace: 'tr-kb',
        });
        toast(existing ? '数据源已保存。' : '数据源已加入财务共享中心。其他部门看不到它。');
        return true;
      },
      setSourceEnabled: (id, enabled) => {
        const source = stateRef.current.sources.find((item) => item.id === id);
        if (!source) return;
        setState((current) => ({
          ...current,
          sources: current.sources.map((item) => (item.id === id ? { ...item, enabled } : item)),
        }));
        log({
          actor: who.name,
          action: enabled ? '启用部门知识库' : '停用部门知识库',
          target: source.name,
          result: '成功',
          trace: 'tr-kb',
        });
        toast(
          enabled ? `${source.name} 已重新纳入检索。` : `${source.name} 已停用，检索不再使用它。`,
        );
      },
      retrySource: (id) => {
        const source = stateRef.current.sources.find((item) => item.id === id);
        if (!source || source.state !== '失败') {
          toast('这个数据源没有失败记录。');
          return;
        }
        setState((current) => ({
          ...current,
          sources: current.sources.map((item) =>
            item.id === id
              ? { ...item, state: '同步成功', when: '刚刚', note: '重试已记录，原型不连接真实系统' }
              : item,
          ),
        }));
        log({
          actor: who.name,
          action: '重试知识库同步',
          target: source.name,
          result: '已记录',
          trace: 'tr-kb',
        });
        toast('已记录重试。原型不连接真实系统，失败文档在此之前仍不可见。');
      },
      retryFailedSources: () => {
        const failed = stateRef.current.sources.filter(
          (item) => item.enabled && item.state === '失败',
        );
        if (failed.length === 0) {
          toast('没有失败的数据源。');
          return;
        }
        setState((current) => ({
          ...current,
          sources: current.sources.map((item) =>
            item.enabled && item.state === '失败'
              ? { ...item, state: '同步成功', when: '刚刚', note: '重试已记录，原型不连接真实系统' }
              : item,
          ),
        }));
        log({
          actor: who.name,
          action: '重试知识库同步',
          target: '全部失败数据源',
          result: '已记录',
          trace: 'tr-kb',
        });
        toast('失败的数据源已标为重试成功。原型不连接真实系统。');
      },
      toggleDeptAgent: (id) => {
        const agent = AGENTS.find((item) => item.id === id);
        const wasOff = stateRef.current.deptAgentsOff.includes(id);
        setState((current) => ({
          ...current,
          deptAgentsOff: wasOff
            ? current.deptAgentsOff.filter((item) => item !== id)
            : [...current.deptAgentsOff, id],
        }));
        log({
          actor: who.name,
          action: wasOff ? '对本部门开放 Agent' : '收回本部门 Agent',
          target: agent?.name ?? id,
          result: '成功',
          trace: 'tr-dept-agent',
        });
        toast(
          wasOff
            ? `${agent?.name ?? id} 已对本部门开放。`
            : `${agent?.name ?? id} 已从本部门收回。成员工作台不再显示它。`,
        );
      },
      savePolicyDraft: (body) => {
        if (loc.role !== 'platform' && loc.role !== 'security') {
          toast('只有平台管理员或安全管理员可以创建策略。');
          return false;
        }
        const name = body.name.trim();
        const reason = body.reason.trim();
        if (!name || !reason) {
          toast('名称和给成员看的原因都要填写。');
          return false;
        }
        if (
          !Number.isFinite(body.expiresInDays) ||
          body.expiresInDays < 1 ||
          body.expiresInDays > 3650
        ) {
          toast('有效期要在 1 到 3650 天之间。');
          return false;
        }
        const existing = stateRef.current.policyDraft;
        if (existing && existing.createdRole !== loc.role) {
          toast(`这份草稿是${existing.createdBy}写的，不能由别人改。`);
          return false;
        }
        const draft: PolicyDraft = {
          ...body,
          name,
          note: body.note.trim(),
          reason,
          createdBy: existing?.createdBy ?? who.name,
          createdRole: existing?.createdRole ?? loc.role,
          createdAt: existing?.createdAt ?? `今天 ${stamp()}`,
        };
        setState((current) => ({ ...current, policyDraft: draft }));
        log({
          actor: who.name,
          action: existing ? '修改策略草稿' : '创建策略',
          target: name,
          result: '草稿',
          trace: 'tr-policy',
        });
        toast('草稿已保存。还没有签发，设备不会变化。');
        return true;
      },
      discardPolicyDraft: (mode) => {
        const draft = stateRef.current.policyDraft;
        if (!draft) return;
        if (mode === 'drop' && draft.createdRole !== loc.role) {
          toast('只有起草人可以放弃这份草稿。');
          return;
        }
        if (mode === 'return' && draft.createdRole === loc.role) {
          toast('起草人请直接放弃草稿。');
          return;
        }
        if (mode === 'return' && loc.role !== 'platform' && loc.role !== 'security') return;
        setState((current) => ({ ...current, policyDraft: null }));
        log({
          actor: who.name,
          action: mode === 'return' ? '退回策略草稿' : '放弃策略草稿',
          target: draft.name,
          result: '已作废',
          trace: 'tr-policy',
        });
        toast(mode === 'return' ? '已退回。要改的话需要重新创建。' : '草稿已放弃。');
      },
      signPolicy: () => {
        const draft = stateRef.current.policyDraft;
        if (!draft) {
          toast('没有待签发的草稿。');
          return;
        }
        if (loc.role !== 'platform' && loc.role !== 'security') {
          toast('只有平台管理员或安全管理员可以签发。');
          return;
        }
        if (draft.createdRole === loc.role) {
          toast('起草人不能签发自己的策略。请换成另一名管理员。');
          return;
        }
        const version = Math.max(...stateRef.current.packs.map((pack) => pack.version)) + 1;
        const issued: PolicyPack = {
          ...draft,
          id: `pack-${version}`,
          version,
          signedBy: who.name,
          signedAt: `今天 ${stamp()}`,
        };
        setState((current) => ({
          ...current,
          packs: [issued, ...current.packs],
          policyDraft: null,
        }));
        log({
          actor: who.name,
          action: '签发策略',
          target: `策略包 v${version}`,
          result: '成功',
          trace: 'tr-policy',
        });
        toast(`v${version} 已签发。设备下次启动时才会拉取，现在仍用旧版本。`);
      },
      nudgeDevices: () => {
        setState((current) => ({ ...current, nudged: true }));
        log({
          actor: who.name,
          action: '催办策略',
          target: '财务室公用电脑',
          result: '已记录',
          trace: 'tr-20440',
        });
        toast('已记录催办。原型没有真正下发策略。');
      },
      reset: () => {
        setState(freshState());
        toast('演示数据已恢复。');
      },
    };
  }, [loc.pathname, loc.query, loc.role, navigate, setRole, state, toast, toasts, log]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
