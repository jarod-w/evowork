/**
 * 插件目录页（05 · 13）。
 *
 * 顶栏采用「发现 / 我的已装」双视图，下设对称的「技能 / 连接器 / 专家」三类切换。
 * 目录元数据与手动刷新收进右上角「精选目录」弹层；目录过期、校验失败与技能预算超限
 * 仍以顶部常驻 Banner 呈现（「不静默降级」）。
 * 数据全是宿主给的：这一层不读盘、不调内核。
 */
import { useMemo, useRef, useState } from 'react';

import type {
  CatalogDataView,
  CatalogExpertView,
  CatalogItemView,
  CatalogMutationResult,
  ConnectorView,
  HubCatalogView,
  HubEntryView,
  HubItemRef,
} from '../../shared/ipc.js';
import { AuditFindings } from '../components/audit-findings.js';
import { InlineSelect, Menu, Popover } from '../components/menu.js';
import {
  Badge,
  Banner,
  Dialog,
  EmptyState,
  FilterChip,
  FilterChipRow,
  GhostButton,
  ItemCard,
  PillButton,
  SearchInput,
  SectionHeader,
  SegmentedControl,
  StatusDot,
} from '../components/primitives.js';

export type CatalogTab = 'experts' | 'skills' | 'connectors';
export type CatalogMode = 'discover' | 'installed';

/** 插件 Hub 的四个动作（13，H1）。宿主没注入时缺席，「发现」会如实提示尚未接入。 */
export interface CatalogHubActions {
  readonly refresh: () => Promise<CatalogMutationResult>;
  readonly install: (
    input: HubItemRef & { acknowledge?: boolean; confirmName?: string; reviewToken?: string },
  ) => Promise<CatalogMutationResult>;
  readonly uninstall: (ref: HubItemRef) => Promise<CatalogMutationResult>;
  readonly rollback: (ref: HubItemRef) => Promise<CatalogMutationResult>;
}

const HUB_KIND: Readonly<Record<CatalogTab, HubItemRef['kind']>> = {
  skills: 'skill',
  experts: 'expert',
  connectors: 'connector',
};

type SkillSourceFilter = 'all' | 'official' | 'hub' | 'local';
type ConnectorStatusFilter = 'all' | 'trusted' | 'untrusted';
type ExpertSelectionFilter = 'all' | 'selected';

export interface CatalogPageProps {
  readonly data: CatalogDataView | null;
  readonly tab: CatalogTab;
  readonly onTab: (tab: CatalogTab) => void;
  readonly refusal?: string | undefined;
  readonly onInstallSkill: (input: {
    kind: 'file' | 'directory' | 'git';
    path?: string;
    url?: string;
    acknowledge?: boolean;
    confirmName?: string;
    reviewToken?: string;
  }) => Promise<CatalogMutationResult>;
  readonly onUninstallSkill: (id: string) => Promise<CatalogMutationResult>;
  readonly onSetSkillEnabled: (input: {
    path: string;
    name: string;
    enabled: boolean;
    allowImplicitInvocation?: boolean;
  }) => Promise<CatalogMutationResult>;
  readonly onAddConnector: (input: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string;
    url?: string;
  }) => Promise<CatalogMutationResult>;
  readonly onTrustConnector: (id: string) => Promise<CatalogMutationResult>;
  readonly onAuthorizeConnector: (id: string) => Promise<CatalogMutationResult>;
  readonly onSetConnectorToolPolicy: (input: {
    id: string;
    tool: string;
    policy: 'default' | 'approve' | 'allow';
  }) => Promise<CatalogMutationResult>;
  readonly onRemoveConnector: (id: string) => Promise<CatalogMutationResult>;
  readonly onCreateExpert: (input: {
    name: string;
    description: string;
    category: string;
    sampleTasks: string;
    instructions?: string;
  }) => Promise<CatalogMutationResult>;
  readonly onRemoveExpert: (id: string) => Promise<CatalogMutationResult>;
  readonly onPickDirectory: () => Promise<string | undefined>;
  readonly onPickSkillFile?: (() => Promise<string | undefined>) | undefined;
  readonly onUsePrompt: (prompt: string, expertId?: string) => void;
  readonly onWriteSkill: () => void;
  readonly onOpenHubSettings?: (() => void) | undefined;
  readonly hubActions?: CatalogHubActions | undefined;
}

type Pending =
  | { readonly kind: 'git' }
  | {
      readonly kind: 'audit';
      readonly skillId: string;
      readonly level: string;
      readonly findings: readonly string[];
      readonly worstCase?: string;
      readonly reviewToken?: string | undefined;
      readonly source:
        | { kind: 'file' | 'directory' | 'git'; path?: string; url?: string }
        | { kind: 'hub'; ref: HubItemRef };
    }
  | { readonly kind: 'connector' }
  | { readonly kind: 'expert' }
  | { readonly kind: 'trust'; readonly connector: ConnectorView }
  | { readonly kind: 'uninstall-package'; readonly name: string; readonly uninstall: () => void }
  | { readonly kind: 'uninstall-skill'; readonly id: string; readonly name: string }
  | { readonly kind: 'remove-expert'; readonly id: string; readonly name: string }
  | { readonly kind: 'remove-connector'; readonly id: string; readonly name: string }
  | null;

const SELECTED_EXPERTS_KEY = 'evowork.catalog.selected-experts';

function loadSelectedExperts(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SELECTED_EXPERTS_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);
  } catch {
    return new Set();
  }
}

function matchesQuery(query: string, ...parts: readonly string[]): boolean {
  return parts.join(' ').toLowerCase().includes(query);
}

export function CatalogPage(props: CatalogPageProps) {
  const [mode, setMode] = useState<CatalogMode>('installed');
  const [query, setQuery] = useState('');
  const [selectedExperts, setSelectedExperts] = useState(loadSelectedExperts);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [skillSource, setSkillSource] = useState<SkillSourceFilter>('all');
  const [connectorFilter, setConnectorFilter] = useState<ConnectorStatusFilter>('all');
  const [expertFilter, setExpertFilter] = useState<ExpertSelectionFilter>('all');
  const [selected, setSelected] = useState<
    | { readonly kind: 'skill'; readonly id: string }
    | { readonly kind: 'connector'; readonly id: string }
    | { readonly kind: 'expert'; readonly id: string }
    | null
  >(null);
  const hubInstalling = useRef(false);
  const [hubBusy, setHubBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [ack, setAck] = useState(false);
  const [connName, setConnName] = useState('');
  const [connTransport, setConnTransport] = useState<'stdio' | 'sse' | 'http'>('stdio');
  const [connCommand, setConnCommand] = useState('');
  const [connArgs, setConnArgs] = useState('');
  const [connUrl, setConnUrl] = useState('');
  const [expertName, setExpertName] = useState('');
  const [expertDesc, setExpertDesc] = useState('');
  const [expertCat, setExpertCat] = useState('未分类');
  const [expertTasks, setExpertTasks] = useState('');
  const [expertInstr, setExpertInstr] = useState('');

  /** Hub 条目同样先过审计（13 §5.3）：P1 / P2 转成确认卡。 */
  const installHub = async (
    ref: HubItemRef & { acknowledge?: boolean; confirmName?: string; reviewToken?: string },
  ): Promise<void> => {
    if (!props.hubActions || hubInstalling.current) return;
    hubInstalling.current = true;
    setHubBusy(true);
    try {
      const result = await props.hubActions.install(ref);
      if (result.needsConfirm && result.audit) {
        setPending({
          kind: 'audit',
          skillId: result.audit.skillId,
          reviewToken: result.audit.reviewToken,
          level: result.audit.level,
          findings: result.audit.findings,
          ...(result.audit.worstCase !== undefined ? { worstCase: result.audit.worstCase } : {}),
          source: { kind: 'hub', ref },
        });
      }
    } finally {
      hubInstalling.current = false;
      setHubBusy(false);
    }
  };

  const data = props.data;
  const skills = data?.skills ?? [];
  const skillGroups = useMemo(() => groupSharedSkills(skills), [skills]);
  const installedSkillGroups = useMemo(
    () => skillGroups.filter((skill) => skill.installed),
    [skillGroups],
  );
  const connectors = data?.connectors ?? [];
  const experts = data?.experts ?? [];
  const allHubEntries = data?.hub?.entries ?? [];

  const installedTotal = installedSkillGroups.length + connectors.length + experts.length;

  const q = query.trim().toLowerCase();
  const hasFilters =
    q !== '' ||
    category !== undefined ||
    (mode === 'installed' &&
      ((props.tab === 'skills' && skillSource !== 'all') ||
        (props.tab === 'connectors' && connectorFilter !== 'all') ||
        (props.tab === 'experts' && expertFilter !== 'all')));

  const clearFilters = () => {
    setQuery('');
    setCategory(undefined);
    setSkillSource('all');
    setConnectorFilter('all');
    setExpertFilter('all');
  };

  const toggleExpert = (id: string) => {
    const next = new Set(selectedExperts);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedExperts(next);
    try {
      localStorage.setItem(SELECTED_EXPERTS_KEY, JSON.stringify([...next]));
    } catch {
      // 存储不可用时保留当前目录会话里的选用状态。
    }
  };

  const skillCategories = useMemo(
    () =>
      [...new Set(installedSkillGroups.map((skill) => skill.category))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [installedSkillGroups],
  );

  const visibleSkills = installedSkillGroups.filter((skill) => {
    if (skillSource === 'official' && skill.source !== 'official') return false;
    if (skillSource === 'hub' && skill.source !== 'hub') return false;
    if (skillSource === 'local' && (skill.source === 'official' || skill.source === 'hub'))
      return false;
    if (category !== undefined && skill.category !== category) return false;
    return matchesQuery(q, skill.name, skill.description, skill.category, skill.sourceLabel);
  });

  const connectorCategories = useMemo(() => {
    const cats = [...new Set(connectors.map((connector) => connector.category))];
    return cats.sort((a, b) => a.localeCompare(b));
  }, [connectors]);

  const visibleConnectors = connectors.filter((connector) => {
    if (connectorFilter === 'trusted' && !connector.trusted) return false;
    if (connectorFilter === 'untrusted' && connector.trusted) return false;
    if (category !== undefined && category !== connector.category) return false;
    return matchesQuery(q, connector.name, statusBadge(connector), connectorStatusText(connector));
  });

  const expertCategories = useMemo(
    () => [...new Set(experts.map((expert) => expert.category))].sort((a, b) => a.localeCompare(b)),
    [experts],
  );

  const visibleExperts = experts.filter((expert) => {
    if (expertFilter === 'selected' && !selectedExperts.has(expert.id)) return false;
    if (category !== undefined && expert.category !== category) return false;
    return matchesQuery(q, expert.name, expert.description, expert.category);
  });

  const hubKindEntries = allHubEntries.filter((entry) => entry.kind === HUB_KIND[props.tab]);
  const hubCategories = useMemo(
    () =>
      [...new Set(hubKindEntries.map((entry) => entry.category))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [hubKindEntries],
  );
  const visibleHubEntries = hubKindEntries.filter(
    (entry) =>
      (category === undefined || entry.category === category) &&
      matchesQuery(q, entry.displayName, entry.description, entry.category),
  );

  const typeCounts: Readonly<Record<CatalogTab, number>> =
    mode === 'installed'
      ? {
          skills: installedSkillGroups.length,
          connectors: connectors.length,
          experts: experts.length,
        }
      : {
          skills: allHubEntries.filter((entry) => entry.kind === 'skill').length,
          connectors: allHubEntries.filter((entry) => entry.kind === 'connector').length,
          experts: allHubEntries.filter((entry) => entry.kind === 'expert').length,
        };

  const activeCategories =
    mode === 'discover'
      ? hubCategories
      : props.tab === 'skills'
        ? skillCategories
        : props.tab === 'connectors'
          ? connectorCategories
          : expertCategories;

  const searchPlaceholder =
    props.tab === 'experts' ? '搜索专家' : props.tab === 'connectors' ? '搜索连接器' : '搜索技能';

  const closeDialog = () => {
    setPending(null);
    setGitUrl('');
    setConfirmName('');
    setAck(false);
    setConnName('');
    setConnCommand('');
    setConnArgs('');
    setConnUrl('');
    setExpertName('');
    setExpertDesc('');
    setExpertTasks('');
    setExpertInstr('');
  };

  const selectedSkill =
    selected?.kind === 'skill' ? skills.find((s) => skillKey(s) === selected.id) : undefined;
  const selectedConnector =
    selected?.kind === 'connector' ? connectors.find((c) => c.id === selected.id) : undefined;
  const selectedExpert =
    selected?.kind === 'expert' ? experts.find((e) => e.id === selected.id) : undefined;

  const hubStatus = data?.hub?.status;

  return (
    <div className="ew-page ew-catalog">
      <div className="ew-page-title-bar ew-catalog-toolbar">
        <SegmentedControl
          variant="dark"
          ariaLabel="插件视图"
          value={mode}
          onChange={(id) => {
            setMode(id as CatalogMode);
            setSelected(null);
            clearFilters();
            setAddOpen(false);
            setHubOpen(false);
          }}
          items={[
            { id: 'discover', label: '发现' },
            { id: 'installed', label: `我的已装 ${installedTotal}` },
          ]}
        />

        <div className="ew-catalog-toolbar-actions">
          {data?.hub && props.hubActions ? (
            <HubStatusControl
              hub={data.hub}
              open={hubOpen}
              onToggle={() => {
                setAddOpen(false);
                setHubOpen((v) => !v);
              }}
              onClose={() => setHubOpen(false)}
              onRefresh={() => {
                setHubOpen(false);
                void props.hubActions?.refresh();
              }}
              onOpenSettings={
                props.onOpenHubSettings
                  ? () => {
                      setHubOpen(false);
                      props.onOpenHubSettings?.();
                    }
                  : undefined
              }
            />
          ) : null}

          {props.tab === 'skills' ? (
            <span className="ew-catalog-add">
              <PillButton
                variant="accent"
                expanded={addOpen}
                onClick={() => {
                  setHubOpen(false);
                  setAddOpen((v) => !v);
                }}
              >
                ＋ 添加技能
              </PillButton>
              <Popover open={addOpen} onClose={() => setAddOpen(false)} align="end">
                <Menu
                  ariaLabel="添加技能"
                  items={[
                    ...(props.onPickSkillFile
                      ? [{ id: 'file', label: '从 SKILL.md 文件安装' }]
                      : []),
                    { id: 'dir', label: '从目录安装' },
                    { id: 'git', label: '从 Git 安装' },
                    { id: 'write', label: '让 EvoWork 帮我写一个' },
                  ]}
                  onSelect={(id) => {
                    setAddOpen(false);
                    if (id === 'dir' || id === 'file') {
                      const pick = id === 'file' ? props.onPickSkillFile : props.onPickDirectory;
                      void pick?.().then(async (path) => {
                        if (path === undefined) return;
                        const kind = id === 'file' ? 'file' : 'directory';
                        const result = await props.onInstallSkill({ kind, path });
                        if (result.needsConfirm && result.audit) {
                          setPending({
                            kind: 'audit',
                            skillId: result.audit.skillId,
                            reviewToken: result.audit.reviewToken,
                            level: result.audit.level,
                            findings: result.audit.findings,
                            ...(result.audit.worstCase !== undefined
                              ? { worstCase: result.audit.worstCase }
                              : {}),
                            source: { kind, path },
                          });
                        }
                      });
                    }
                    if (id === 'git') setPending({ kind: 'git' });
                    if (id === 'write') props.onWriteSkill();
                  }}
                />
              </Popover>
            </span>
          ) : null}

          {props.tab === 'connectors' ? (
            <PillButton variant="accent" onClick={() => setPending({ kind: 'connector' })}>
              ＋ 自定义连接器
            </PillButton>
          ) : null}

          {props.tab === 'experts' ? (
            <PillButton variant="accent" onClick={() => setPending({ kind: 'expert' })}>
              ＋ 新建专家
            </PillButton>
          ) : null}
        </div>
      </div>

      <div className="ew-content-column">
        {hubBusy ? (
          <p role="status" className="ew-catalog-muted">
            正在安装技能并准备所需组件，请稍候…
          </p>
        ) : null}
        {props.refusal ? <p className="ew-projects-refusal">{props.refusal}</p> : null}
        {hubStatus?.warning !== undefined ? (
          <Banner tone="warning">{hubStatus.warning}</Banner>
        ) : null}
        {hubStatus?.expired ? (
          <Banner
            tone="warning"
            action={
              hubStatus.canRefresh && props.hubActions ? (
                <PillButton onClick={() => void props.hubActions?.refresh()}>刷新目录</PillButton>
              ) : undefined
            }
          >
            {hubStatus.sourceName}目录已
            {hubStatus.expiresAt !== undefined ? `于 ${formatHubDate(hubStatus.expiresAt)} ` : ''}
            过期，暂时不能安装新内容。
            {hubStatus.fetchMode === 'offline'
              ? '请更新离线内容包。'
              : '服务器尚未提供有效的新目录，需要维护者更新。'}
            已安装内容可继续使用。
          </Banner>
        ) : null}
        {props.tab === 'skills' && data?.skillBudget?.over ? (
          <Banner tone={data.skillBudget.basis === 'fallback' ? 'info' : 'warning'}>
            <p>
              {data.skillBudget.basis === 'fallback'
                ? '技能目录超过参考预算，尚未取得完整的可用模型窗口信息'
                : (data.skillBudget.warning ??
                  '已启用技能的目录预计超出预算，部分说明可能被缩短或省略')}
            </p>
            <p>
              目录估算占用 {data.skillBudget.used.toLocaleString('zh-CN')} /{' '}
              {data.skillBudget.budget.toLocaleString('zh-CN')} token
              {data.skillBudget.basis === 'available-models'
                ? `（按可用模型的最小窗口 ${data.skillBudget.contextWindow?.toLocaleString('zh-CN')} token 的 2% 估算）`
                : '（按 128,000 token 窗口的参考基线估算，不代表当前模型已超限）'}
              。
              {data.skillBudget.enabledCount !== undefined
                ? `计入 ${data.skillBudget.enabledCount} 个启用副本。`
                : null}
              可停用不常用的技能或多余副本，实际可见内容取决于所用模型。
            </p>
          </Banner>
        ) : null}
        {(data?.skillErrors ?? []).map((error) => (
          <p key={`${error.path}:${error.message}`} className="ew-projects-refusal">
            技能加载失败：{error.path}（{error.message}）
          </p>
        ))}
        {(data?.connectorErrors ?? []).map((error) => (
          <p key={error} className="ew-projects-refusal">
            连接器状态读取失败：{error}
          </p>
        ))}

        {selectedSkill ? (
          <SkillDetail
            skill={selectedSkill}
            copies={
              skillGroups.find((group) =>
                group.copies?.some((copy) => skillKey(copy) === skillKey(selectedSkill)),
              )?.copies
            }
            onSelectCopy={(copy) => setSelected({ kind: 'skill', id: skillKey(copy) })}
            onBack={() => setSelected(null)}
            onUse={() => {
              if (selectedSkill.defaultPrompt) props.onUsePrompt(selectedSkill.defaultPrompt);
            }}
            onSetEnabled={
              selectedSkill.skillPath
                ? (enabled, allowImplicitInvocation) =>
                    void props.onSetSkillEnabled({
                      path: selectedSkill.skillPath!,
                      name: selectedSkill.id,
                      enabled,
                      ...(allowImplicitInvocation !== undefined ? { allowImplicitInvocation } : {}),
                    })
                : undefined
            }
            onUninstall={
              selectedSkill.source === 'official' || selectedSkill.uninstallDisabledReason
                ? undefined
                : () =>
                    setPending({
                      kind: 'uninstall-skill',
                      id: selectedSkill.id,
                      name: selectedSkill.name,
                    })
            }
          />
        ) : selectedConnector ? (
          <ConnectorDetail
            connector={selectedConnector}
            onBack={() => setSelected(null)}
            onTrust={() => setPending({ kind: 'trust', connector: selectedConnector })}
            onAuthorize={() => void props.onAuthorizeConnector(selectedConnector.id)}
            onSetToolPolicy={(tool, policy) =>
              void props.onSetConnectorToolPolicy({ id: selectedConnector.id, tool, policy })
            }
            onRemove={() =>
              setPending({
                kind: 'remove-connector',
                id: selectedConnector.id,
                name: selectedConnector.name,
              })
            }
          />
        ) : selectedExpert ? (
          <ExpertDetail
            expert={selectedExpert}
            selected={selectedExperts.has(selectedExpert.id)}
            onToggle={() => toggleExpert(selectedExpert.id)}
            onBack={() => setSelected(null)}
            onUse={(prompt) => props.onUsePrompt(prompt, selectedExpert.id)}
            onRemove={
              selectedExpert.source === 'official'
                ? undefined
                : () =>
                    setPending({
                      kind: 'remove-expert',
                      id: selectedExpert.id,
                      name: selectedExpert.name,
                    })
            }
          />
        ) : (
          <>
            <div className="ew-catalog-controls">
              <div className="ew-catalog-type-tabs" role="tablist" aria-label="插件类型">
                {(
                  [
                    { id: 'skills', label: '技能' },
                    { id: 'connectors', label: '连接器' },
                    { id: 'experts', label: '专家' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-label={item.label}
                    aria-selected={props.tab === item.id}
                    className="ew-catalog-type-tab"
                    data-selected={props.tab === item.id ? 'true' : undefined}
                    onClick={() => {
                      props.onTab(item.id);
                      setSelected(null);
                      setCategory(undefined);
                      setAddOpen(false);
                    }}
                  >
                    <span>{item.label}</span>
                    <span className="ew-catalog-type-count" aria-hidden="true">
                      {typeCounts[item.id]}
                    </span>
                  </button>
                ))}
              </div>

              <div className="ew-catalog-filter-tools">
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={searchPlaceholder}
                  ariaLabel={searchPlaceholder}
                />
                {mode === 'installed' && props.tab === 'skills' ? (
                  <InlineSelect
                    ariaLabel="来源筛选"
                    placeholder="全部来源"
                    value={skillSource}
                    options={[
                      { id: 'all', label: '全部来源' },
                      { id: 'official', label: '官方内置' },
                      { id: 'hub', label: 'EvoWork 精选' },
                      { id: 'local', label: '本地与共享' },
                    ]}
                    onChange={(id) => setSkillSource(id as SkillSourceFilter)}
                  />
                ) : null}
                {mode === 'installed' && props.tab === 'connectors' ? (
                  <InlineSelect
                    ariaLabel="连接器状态筛选"
                    placeholder="全部状态"
                    value={connectorFilter}
                    options={[
                      { id: 'all', label: '全部状态' },
                      {
                        id: 'trusted',
                        label: `已信任 ${connectors.filter((c) => c.trusted).length}`,
                      },
                      {
                        id: 'untrusted',
                        label: `待信任 ${connectors.filter((c) => !c.trusted).length}`,
                      },
                    ]}
                    onChange={(id) => setConnectorFilter(id as ConnectorStatusFilter)}
                  />
                ) : null}
                {mode === 'installed' && props.tab === 'experts' ? (
                  <InlineSelect
                    ariaLabel="专家筛选"
                    placeholder="全部专家"
                    value={expertFilter}
                    options={[
                      { id: 'all', label: '全部专家' },
                      {
                        id: 'selected',
                        label: `已选用 ${experts.filter((e) => selectedExperts.has(e.id)).length}`,
                      },
                    ]}
                    onChange={(id) => setExpertFilter(id as ExpertSelectionFilter)}
                  />
                ) : null}
              </div>
            </div>

            {activeCategories.length > 1 ? (
              <FilterChipRow ariaLabel="分类筛选">
                <FilterChip
                  label="全部"
                  selected={category === undefined}
                  onClick={() => setCategory(undefined)}
                />
                {activeCategories.map((c) => (
                  <FilterChip
                    key={c}
                    label={formatCategoryLabel(props.tab, c)}
                    selected={category === c}
                    onClick={() => setCategory(category === c ? undefined : c)}
                  />
                ))}
              </FilterChipRow>
            ) : null}

            {mode === 'discover' ? (
              <HubGrid
                entries={visibleHubEntries}
                hasFilters={hasFilters}
                onClearFilters={hasFilters ? clearFilters : undefined}
                hub={data?.hub}
                onRefresh={props.hubActions ? () => void props.hubActions?.refresh() : undefined}
                onOpenSettings={props.onOpenHubSettings}
                onGoInstalled={() => {
                  setMode('installed');
                  clearFilters();
                }}
                onInstall={(ref) => void installHub(ref)}
                onUninstall={(entry) =>
                  setPending({
                    kind: 'uninstall-package',
                    name: entry.displayName,
                    uninstall: () =>
                      void props.hubActions?.uninstall({ kind: entry.kind, id: entry.id }),
                  })
                }
                onRollback={(ref) => void props.hubActions?.rollback(ref)}
              />
            ) : props.tab === 'skills' ? (
              <SkillsGrid
                visible={visibleSkills}
                onClearFilters={hasFilters ? clearFilters : undefined}
                query={query}
                onSelect={(id) => setSelected({ kind: 'skill', id })}
                onWrite={props.onWriteSkill}
                onGoDiscover={() => {
                  setMode('discover');
                  clearFilters();
                }}
              />
            ) : props.tab === 'connectors' ? (
              <ConnectorsGrid
                rows={visibleConnectors}
                onClearFilters={hasFilters ? clearFilters : undefined}
                query={query}
                onSelect={(id) => setSelected({ kind: 'connector', id })}
                onAdd={() => setPending({ kind: 'connector' })}
              />
            ) : (
              <ExpertsGrid
                rows={visibleExperts}
                selected={selectedExperts}
                onToggle={toggleExpert}
                onClearFilters={hasFilters ? clearFilters : undefined}
                query={query}
                expertFilter={expertFilter}
                onSelect={(id) => setSelected({ kind: 'expert', id })}
                onCreate={() => setPending({ kind: 'expert' })}
              />
            )}
          </>
        )}
      </div>

      {pending?.kind === 'git' ? (
        <Dialog
          title="从 Git 安装技能"
          confirmLabel="安装"
          confirmDisabled={gitUrl.trim() === ''}
          onCancel={closeDialog}
          onConfirm={() => {
            const url = gitUrl.trim();
            closeDialog();
            void props.onInstallSkill({ kind: 'git', url }).then((result) => {
              if (result.needsConfirm && result.audit) {
                setPending({
                  kind: 'audit',
                  skillId: result.audit.skillId,
                  reviewToken: result.audit.reviewToken,
                  level: result.audit.level,
                  findings: result.audit.findings,
                  ...(result.audit.worstCase !== undefined
                    ? { worstCase: result.audit.worstCase }
                    : {}),
                  source: { kind: 'git', url },
                });
              }
            });
          }}
        >
          <label className="ew-dialog-field">
            仓库地址
            <input
              className="ew-dialog-input"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://… 或 git@…"
            />
          </label>
        </Dialog>
      ) : null}

      {pending?.kind === 'audit' ? (
        <Dialog
          title={
            pending.level === 'p2'
              ? pending.source.kind === 'hub'
                ? '高风险内容'
                : '高风险技能'
              : pending.level === 'p1'
                ? '安装前请确认'
                : '安装技能'
          }
          confirmLabel="安装"
          variant={pending.level === 'p2' ? 'danger' : 'default'}
          confirmDisabled={
            (pending.level === 'p1' && !ack) ||
            (pending.level === 'p2' && confirmName.trim() !== pending.skillId)
          }
          onCancel={closeDialog}
          onConfirm={() => {
            const source = pending.source;
            closeDialog();
            if (source.kind === 'hub') {
              void installHub({
                ...source.ref,
                ...(pending.reviewToken ? { reviewToken: pending.reviewToken } : {}),
                acknowledge: true,
                ...(pending.level === 'p2' ? { confirmName: pending.skillId } : {}),
              });
              return;
            }
            void props.onInstallSkill({
              kind: source.kind,
              ...(pending.reviewToken ? { reviewToken: pending.reviewToken } : {}),
              ...(source.path !== undefined ? { path: source.path } : {}),
              ...(source.url !== undefined ? { url: source.url } : {}),
              acknowledge: true,
              ...(pending.level === 'p2' ? { confirmName: pending.skillId } : {}),
            });
          }}
        >
          <p>
            {pending.level === 'p0'
              ? '低风险：只读工作空间，无网络、无 shell、无 hooks。'
              : pending.level === 'p1'
                ? '需注意。安装前请逐项看过：'
                : pending.source.kind === 'hub'
                  ? '高风险。输入名称以确认你知道它能做什么最坏的事。'
                  : '高风险。输入技能名以确认你知道它能做什么最坏的事。'}
          </p>
          <AuditFindings findings={pending.findings} />
          {pending.worstCase ? <p className="ew-catalog-worst">{pending.worstCase}</p> : null}
          {pending.level === 'p1' ? (
            <label className="ew-dialog-field">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{' '}
              我已了解
            </label>
          ) : null}
          {pending.level === 'p2' ? (
            <label className="ew-dialog-field">
              输入
              {pending.source.kind === 'hub' ? '名称' : '技能名'}「{pending.skillId}」确认
              <input
                className="ew-dialog-input"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
              />
            </label>
          ) : null}
        </Dialog>
      ) : null}

      {pending?.kind === 'connector' ? (
        <Dialog
          title="自定义连接器"
          confirmLabel="添加（先不启动）"
          confirmDisabled={
            connName.trim() === '' ||
            (connTransport === 'stdio' ? connCommand.trim() === '' : connUrl.trim() === '')
          }
          onCancel={closeDialog}
          onConfirm={() => {
            const input = {
              name: connName.trim(),
              transport: connTransport,
              ...(connTransport === 'stdio'
                ? {
                    command: connCommand.trim(),
                    ...(connArgs.trim() !== '' ? { args: connArgs.trim() } : {}),
                  }
                : { url: connUrl.trim() }),
            };
            closeDialog();
            void props.onAddConnector(input);
          }}
        >
          <p>添加后是「待信任」。信任并启用之前不会启动这个进程。</p>
          <label className="ew-dialog-field">
            名称
            <input
              className="ew-dialog-input"
              value={connName}
              onChange={(e) => setConnName(e.target.value)}
            />
          </label>
          <label className="ew-dialog-field">
            传输
            <select
              className="ew-dialog-input"
              value={connTransport}
              onChange={(e) => setConnTransport(e.target.value as 'stdio' | 'sse' | 'http')}
            >
              <option value="stdio">stdio</option>
              <option value="sse">SSE</option>
              <option value="http">HTTP</option>
            </select>
          </label>
          {connTransport === 'stdio' ? (
            <>
              <label className="ew-dialog-field">
                命令
                <input
                  className="ew-dialog-input"
                  value={connCommand}
                  onChange={(e) => setConnCommand(e.target.value)}
                  placeholder="npx / node / 绝对路径"
                />
              </label>
              <label className="ew-dialog-field">
                参数（空格分隔）
                <input
                  className="ew-dialog-input"
                  value={connArgs}
                  onChange={(e) => setConnArgs(e.target.value)}
                />
              </label>
            </>
          ) : (
            <label className="ew-dialog-field">
              URL
              <input
                className="ew-dialog-input"
                value={connUrl}
                onChange={(e) => setConnUrl(e.target.value)}
              />
            </label>
          )}
        </Dialog>
      ) : null}

      {pending?.kind === 'trust' ? (
        <Dialog
          title={`信任「${pending.connector.name}」`}
          confirmLabel="信任并启用"
          variant="danger"
          onCancel={closeDialog}
          onConfirm={() => {
            const id = pending.connector.id;
            closeDialog();
            void props.onTrustConnector(id);
          }}
        >
          <p>MCP server 是外部进程，能力面无法静态穷举。信任后每个工具默认「需审批」。</p>
          {pending.connector.command ? (
            <p>
              命令：<code>{pending.connector.command}</code>
              {pending.connector.args?.length ? ` ${pending.connector.args.join(' ')}` : ''}
            </p>
          ) : null}
          {pending.connector.url ? (
            <p>
              URL：<code>{pending.connector.url}</code>
            </p>
          ) : null}
        </Dialog>
      ) : null}

      {pending?.kind === 'expert' ? (
        <Dialog
          title="新建专家"
          confirmLabel="创建"
          confirmDisabled={expertName.trim() === ''}
          onCancel={closeDialog}
          onConfirm={() => {
            const input = {
              name: expertName.trim(),
              description: expertDesc.trim(),
              category: expertCat.trim() || '未分类',
              sampleTasks: expertTasks,
              ...(expertInstr.trim() !== '' ? { instructions: expertInstr.trim() } : {}),
            };
            closeDialog();
            void props.onCreateExpert(input);
          }}
        >
          <label className="ew-dialog-field">
            名称
            <input
              className="ew-dialog-input"
              value={expertName}
              onChange={(e) => setExpertName(e.target.value)}
            />
          </label>
          <label className="ew-dialog-field">
            一句话描述
            <input
              className="ew-dialog-input"
              value={expertDesc}
              onChange={(e) => setExpertDesc(e.target.value)}
            />
          </label>
          <label className="ew-dialog-field">
            分类
            <input
              className="ew-dialog-input"
              value={expertCat}
              onChange={(e) => setExpertCat(e.target.value)}
            />
          </label>
          <label className="ew-dialog-field">
            擅长任务（逗号分隔）
            <input
              className="ew-dialog-input"
              value={expertTasks}
              onChange={(e) => setExpertTasks(e.target.value)}
            />
          </label>
          <label className="ew-dialog-field">
            独立指令
            <textarea
              className="ew-dialog-input"
              value={expertInstr}
              onChange={(e) => setExpertInstr(e.target.value)}
            />
          </label>
        </Dialog>
      ) : null}

      {pending?.kind === 'uninstall-package' ? (
        <Dialog
          title={`卸载「${pending.name}」`}
          confirmLabel="卸载"
          variant="danger"
          onCancel={closeDialog}
          onConfirm={() => {
            closeDialog();
            pending.uninstall();
          }}
        >
          <p>卸载后，本机任务需要重新安装才能使用此插件。</p>
        </Dialog>
      ) : null}

      {pending?.kind === 'uninstall-skill' ? (
        <Dialog
          title={`卸载「${pending.name}」`}
          confirmLabel="卸载"
          variant="danger"
          onCancel={closeDialog}
          onConfirm={() => {
            const id = pending.id;
            closeDialog();
            setSelected(null);
            void props.onUninstallSkill(id);
          }}
        >
          <p>只删本机这份技能目录，不碰工作空间里已经生成的文件。</p>
        </Dialog>
      ) : null}

      {pending?.kind === 'remove-expert' ? (
        <Dialog
          title={`删除「${pending.name}」`}
          confirmLabel="删除"
          variant="danger"
          onCancel={closeDialog}
          onConfirm={() => {
            const id = pending.id;
            closeDialog();
            setSelected(null);
            void props.onRemoveExpert(id);
          }}
        >
          <p>删除这份角色配置。已经用它跑过的任务还在。</p>
        </Dialog>
      ) : null}

      {pending?.kind === 'remove-connector' ? (
        <Dialog
          title={`移除「${pending.name}」`}
          confirmLabel="移除"
          variant="danger"
          onCancel={closeDialog}
          onConfirm={() => {
            const id = pending.id;
            closeDialog();
            setSelected(null);
            void props.onRemoveConnector(id);
          }}
        >
          <p>
            {pending.id === 'browser'
              ? '官方连接器不会被删掉，只会取消信任、不再启动。'
              : '从本机配置里拿掉。下次任务不会再拉起它。'}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function formatCategoryLabel(tab: CatalogTab, category: string): string {
  if (tab === 'connectors') {
    if (category === 'browser') return '浏览器';
    if (category === 'custom') return '自建';
  }
  return category;
}

function SkillsGrid({
  onClearFilters,
  visible,
  query,
  onSelect,
  onWrite,
  onGoDiscover,
}: {
  readonly onClearFilters?: (() => void) | undefined;
  readonly visible: readonly SkillCardView[];
  readonly query: string;
  readonly onSelect: (id: string) => void;
  readonly onWrite: () => void;
  readonly onGoDiscover: () => void;
}) {
  if (visible.length === 0) {
    return (
      <EmptyState
        title={
          query.trim()
            ? `没有找到「${query.trim()}」`
            : onClearFilters
              ? '当前筛选下暂无已安装技能'
              : '还没有已安装的技能'
        }
        hint={
          !onClearFilters
            ? '办公技能会随产品分发。若这里是空的，说明随包的 plugins/skills 没装上。'
            : undefined
        }
        action={
          onClearFilters ? (
            <div className="ew-catalog-detail-actions">
              <PillButton onClick={onClearFilters}>浏览全部技能</PillButton>
              {query.trim() ? (
                <PillButton onClick={onWrite}>让 EvoWork 帮我写一个技能</PillButton>
              ) : null}
            </div>
          ) : (
            <PillButton variant="accent" onClick={onGoDiscover}>
              去发现更多技能
            </PillButton>
          )
        }
      />
    );
  }

  return (
    <div className="ew-projects-grid">
      {visible.map((s) => (
        <SkillCard key={skillKey(s)} skill={s} onSelect={onSelect} />
      ))}
    </div>
  );
}

type SkillCardView = CatalogItemView & { readonly copies?: readonly CatalogItemView[] };

/** 同名同描述的共享技能合为一张卡；实际文件、选择和启停仍按路径区分。 */
function groupSharedSkills(skills: readonly CatalogItemView[]): readonly SkillCardView[] {
  const groups = new Map<string, CatalogItemView[]>();
  for (const skill of skills) {
    const key =
      skill.sourceLabel === '用户共享' && skill.skillPath && skill.uninstallDisabledReason
        ? JSON.stringify([
            skill.id,
            skill.name,
            skill.description,
            skill.scope,
            skill.category,
            skill.riskLevel,
          ])
        : skillKey(skill);
    const copies = groups.get(key);
    if (copies) copies.push(skill);
    else groups.set(key, [skill]);
  }
  return [...groups.values()].map((copies) => ({
    ...copies[0]!,
    enabled: copies.some((copy) => copy.enabled !== false),
    copies,
  }));
}

function skillKey(skill: CatalogItemView): string {
  return skill.skillPath ?? skill.id;
}

function SkillCard({
  skill,
  onSelect,
}: {
  readonly skill: SkillCardView;
  readonly onSelect: (id: string) => void;
}) {
  const metaParts = [
    skill.sourceLabel,
    skill.riskLabel,
    ...(skill.copies && skill.copies.length > 1 ? [`${skill.copies.length} 个副本`] : []),
  ];
  const meta = metaParts.join(' · ');
  return (
    <ItemCard
      name={skill.name}
      description={skill.description}
      tone={skill.riskLevel === 'p2' ? 'warning' : 'default'}
      action={
        <Badge variant={skill.enabled !== false ? 'success' : 'neutral'}>
          {skill.enabled === false ? '已停用' : '已启用'}
        </Badge>
      }
      footer={
        <>
          <span className="ew-catalog-card-meta" title={meta}>
            {meta}
          </span>
          <span className="ew-catalog-card-actions">
            <PillButton
              variant="ghost"
              ariaLabel={`管理 · ${skill.name}`}
              onClick={() => onSelect(skillKey(skill))}
            >
              管理
            </PillButton>
          </span>
        </>
      }
    />
  );
}

function ConnectorsGrid({
  onClearFilters,
  rows,
  query,
  onSelect,
  onAdd,
}: {
  readonly onClearFilters?: (() => void) | undefined;
  readonly rows: readonly ConnectorView[];
  readonly query: string;
  readonly onSelect: (id: string) => void;
  readonly onAdd: () => void;
}) {
  return (
    <>
      <p className="ew-catalog-caption">
        本版支持通过 MCP 协议接入任意第三方服务。官方连接器目录将在后续版本提供。
      </p>
      {rows.length === 0 ? (
        <EmptyState
          title={
            query.trim()
              ? `没有找到「${query.trim()}」`
              : onClearFilters
                ? '没有符合筛选条件的连接器'
                : '还没有连接器'
          }
          hint={onClearFilters ? undefined : '可以添加自定义 MCP。'}
          action={
            onClearFilters ? (
              <PillButton onClick={onClearFilters}>浏览全部连接器</PillButton>
            ) : (
              <PillButton variant="accent" onClick={onAdd}>
                ＋ 自定义连接器
              </PillButton>
            )
          }
        />
      ) : (
        <div className="ew-projects-grid">
          {rows.map((c) => {
            const source =
              c.kind === 'official' ? '官方内置' : c.kind === 'hub' ? 'EvoWork 精选' : '自建';
            const needsAction = c.status === 'needs-auth' || !c.trusted;
            const actionLabel = needsAction ? '查看权限' : '管理';
            return (
              <ItemCard
                key={c.id}
                name={c.name}
                description={connectorStatusText(c)}
                tone={c.status === 'failed' || c.status === 'disabled' ? 'warning' : 'default'}
                action={
                  <Badge
                    variant={
                      c.status === 'connected' || c.trusted
                        ? 'success'
                        : c.status === 'failed'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {statusBadge(c)}
                  </Badge>
                }
                footer={
                  <>
                    <span className="ew-catalog-card-meta" title={source}>
                      {source}
                    </span>
                    <span className="ew-catalog-card-actions">
                      <PillButton
                        variant={needsAction ? 'accent' : 'ghost'}
                        ariaLabel={`${actionLabel} · ${c.name}`}
                        onClick={() => onSelect(c.id)}
                      >
                        {actionLabel}
                      </PillButton>
                    </span>
                  </>
                }
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function ExpertsGrid({
  rows,
  selected,
  onToggle,
  onClearFilters,
  query,
  expertFilter,
  onSelect,
  onCreate,
}: {
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onClearFilters?: (() => void) | undefined;
  readonly rows: readonly CatalogExpertView[];
  readonly query: string;
  readonly expertFilter: ExpertSelectionFilter;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={
          query.trim()
            ? `没有找到「${query.trim()}」`
            : expertFilter === 'selected'
              ? '还没有已选用的专家'
              : onClearFilters
                ? '当前筛选下暂无专家'
                : '还没有专家'
        }
        hint={onClearFilters ? undefined : '新建专家后，可以从目录选用或直接对话。'}
        action={
          onClearFilters ? (
            <PillButton onClick={onClearFilters}>浏览全部专家</PillButton>
          ) : (
            <PillButton variant="accent" onClick={onCreate}>
              ＋ 新建专家
            </PillButton>
          )
        }
      />
    );
  }
  return (
    <div className="ew-projects-grid">
      {rows.map((e) => {
        const meta = `${e.category} · ${
          e.source === 'official' ? '官方内置' : e.source === 'hub' ? 'EvoWork 精选' : '本地目录'
        }`;
        return (
          <ItemCard
            key={e.id}
            name={e.name}
            description={e.description}
            action={
              <Badge variant={selected.has(e.id) ? 'success' : 'neutral'}>
                {selected.has(e.id) ? '已选用' : '未选用'}
              </Badge>
            }
            footer={
              <>
                <span className="ew-catalog-card-meta" title={meta}>
                  {meta}
                </span>
                <span className="ew-catalog-card-actions">
                  <PillButton
                    variant="ghost"
                    ariaLabel={`${selected.has(e.id) ? '取消选用' : '选用'} · ${e.name}`}
                    onClick={() => onToggle(e.id)}
                  >
                    {selected.has(e.id) ? '取消选用' : '选用'}
                  </PillButton>
                  <PillButton
                    variant="ghost"
                    ariaLabel={`查看详情 · ${e.name}`}
                    onClick={() => onSelect(e.id)}
                  >
                    管理
                  </PillButton>
                </span>
              </>
            }
          />
        );
      })}
    </div>
  );
}

function SkillDetail({
  skill,
  copies,
  onSelectCopy,
  onBack,
  onUse,
  onUninstall,
  onSetEnabled,
}: {
  readonly skill: CatalogItemView;
  readonly copies?: readonly CatalogItemView[] | undefined;
  readonly onSelectCopy: (copy: CatalogItemView) => void;
  readonly onBack: () => void;
  readonly onUse: () => void;
  readonly onUninstall?: (() => void) | undefined;
  readonly onSetEnabled?:
    ((enabled: boolean, allowImplicitInvocation?: boolean) => void) | undefined;
}) {
  return (
    <div className="ew-catalog-detail">
      <GhostButton label="返回列表" onClick={onBack} />
      <h1 className="ew-catalog-detail-title">{skill.name}</h1>
      <p className="ew-catalog-detail-desc">{skill.description}</p>
      <p className="ew-catalog-detail-meta">
        {skill.sourceLabel} · {skill.riskLabel} · {skill.category}
      </p>
      {skill.scope ? (
        <p className="ew-catalog-detail-meta">
          作用域：{skill.scope} · {skill.enabled === false ? '已停用' : '已启用'}
        </p>
      ) : null}
      {copies && copies.length > 1 ? (
        <div className="ew-catalog-detail-meta">
          <p>
            发现 {copies.length} 个同名同描述的共享副本，附带文件可能不同。
            每个启用副本都会计入目录预算，可选择副本查看并停用多余项。
          </p>
          {copies.map((copy, index) => (
            <p key={skillKey(copy)}>
              <PillButton
                aria-pressed={skillKey(copy) === skillKey(skill)}
                onClick={() => onSelectCopy(copy)}
              >
                副本 {index + 1} · {copy.enabled === false ? '已停用' : '已启用'}
              </PillButton>{' '}
              {copy.skillPath}
            </p>
          ))}
        </div>
      ) : null}
      <p className="ew-catalog-detail-meta">
        调用方式：
        {skill.allowImplicitInvocation === false ? '仅手动调用' : '自动匹配，也可手动调用'}
      </p>
      {skill.skillPath ? (
        <p className="ew-catalog-detail-meta">{`位置：${skill.skillPath}`}</p>
      ) : null}
      {skill.findings.length > 0 ? (
        <ul className="ew-catalog-findings">
          {skill.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
      {skill.worstCase ? <p className="ew-catalog-worst">{skill.worstCase}</p> : null}
      <div className="ew-catalog-detail-actions">
        {onSetEnabled ? (
          <PillButton onClick={() => onSetEnabled(skill.enabled === false)}>
            {skill.enabled === false ? '启用' : '停用'}
          </PillButton>
        ) : null}
        {skill.invocationEditable && onSetEnabled ? (
          <PillButton
            onClick={() =>
              onSetEnabled(skill.enabled !== false, skill.allowImplicitInvocation === false)
            }
          >
            {skill.allowImplicitInvocation === false ? '允许自动匹配' : '设为仅手动调用'}
          </PillButton>
        ) : null}
        {skill.defaultPrompt ? (
          <PillButton variant="accent" onClick={onUse}>
            用它新建任务
          </PillButton>
        ) : null}
        {onUninstall ? (
          <PillButton onClick={onUninstall}>卸载</PillButton>
        ) : (
          <span className="ew-catalog-muted">
            {skill.uninstallDisabledReason ?? '官方内置技能不能卸载。'}
          </span>
        )}
      </div>
    </div>
  );
}

function ConnectorDetail({
  connector,
  onBack,
  onTrust,
  onAuthorize,
  onSetToolPolicy,
  onRemove,
}: {
  readonly connector: ConnectorView;
  readonly onBack: () => void;
  readonly onTrust: () => void;
  readonly onAuthorize: () => void;
  readonly onSetToolPolicy: (tool: string, policy: 'default' | 'approve' | 'allow') => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="ew-catalog-detail">
      <GhostButton label="返回列表" onClick={onBack} />
      <h1 className="ew-catalog-detail-title">{connector.name}</h1>
      <p className="ew-catalog-detail-desc">{connectorStatusText(connector)}</p>
      {connector.id === 'browser' ? (
        <p className="ew-catalog-detail-desc">
          联网搜索与网页读取无需配置 Key。需要本机安装 Chrome /
          Chromium；搜索摘要与已读正文分别标注，回答来源可点击核对。
        </p>
      ) : null}
      {connector.command ? (
        <p>
          命令：<code>{connector.command}</code>
        </p>
      ) : null}
      {connector.url ? (
        <p>
          URL：<code>{connector.url}</code>
        </p>
      ) : null}
      {connector.disabledReason ? (
        <p className="ew-catalog-worst">{connector.disabledReason}</p>
      ) : null}
      {connector.authStatus ? (
        <p className="ew-catalog-detail-meta">
          授权状态：{connectorAuthText(connector.authStatus)}
        </p>
      ) : null}
      {(connector.tools ?? []).length > 0 ? (
        <>
          <SectionHeader title="工具权限" />
          <p className="ew-catalog-detail-desc">
            默认按工具风险判断；也可以逐项要求确认或直接允许。
          </p>
          <div className="ew-catalog-samples">
            {(connector.tools ?? []).map((tool) => (
              <label key={tool} className="ew-dialog-field">
                <code>{tool}</code>
                <select
                  className="ew-dialog-input"
                  value={connector.toolPolicy[tool] ?? 'default'}
                  onChange={(event) =>
                    onSetToolPolicy(tool, event.target.value as 'default' | 'approve' | 'allow')
                  }
                >
                  <option value="default">默认（按工具风险）</option>
                  <option value="approve">每次确认</option>
                  <option value="allow">直接允许</option>
                </select>
              </label>
            ))}
          </div>
        </>
      ) : null}
      <div className="ew-catalog-detail-actions">
        {connector.trusted ? null : (
          <PillButton variant="accent" onClick={onTrust}>
            信任并启用
          </PillButton>
        )}
        {connector.status === 'needs-auth' ? (
          <PillButton variant="accent" onClick={onAuthorize}>
            去授权
          </PillButton>
        ) : null}
        <PillButton onClick={onRemove}>
          {connector.id === 'browser' ? '取消信任' : '移除'}
        </PillButton>
      </div>
    </div>
  );
}

function connectorAuthText(status: NonNullable<ConnectorView['authStatus']>): string {
  if (status === 'notLoggedIn') return '尚未授权';
  if (status === 'oAuth') return 'OAuth 已授权';
  if (status === 'bearerToken') return '已配置访问令牌';
  if (status === 'unsupported') return '不需要 OAuth';
  return '状态未知';
}

function ExpertDetail({
  expert,
  selected,
  onToggle,
  onBack,
  onUse,
  onRemove,
}: {
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly expert: CatalogExpertView;
  readonly onBack: () => void;
  readonly onUse: (prompt: string) => void;
  readonly onRemove?: (() => void) | undefined;
}) {
  return (
    <div className="ew-catalog-detail">
      <GhostButton label="返回列表" onClick={onBack} />
      <h1 className="ew-catalog-detail-title">{expert.name}</h1>
      <p className="ew-catalog-detail-desc">{expert.description}</p>
      <p className="ew-catalog-detail-meta">{expert.category}</p>
      <p className="ew-catalog-detail-meta">
        选用状态用于本机插件目录筛选。可用下方示例或「直接对话」开启任务。
      </p>
      {expert.instructions ? (
        <pre className="ew-catalog-instructions">{expert.instructions}</pre>
      ) : null}
      {expert.sampleTasks.length > 0 ? (
        <>
          <SectionHeader title="擅长任务" />
          <div className="ew-catalog-samples">
            {expert.sampleTasks.map((t) => (
              <PillButton key={t} onClick={() => onUse(t)}>
                {t}
              </PillButton>
            ))}
          </div>
        </>
      ) : null}
      <div className="ew-catalog-detail-actions">
        <PillButton variant="accent" onClick={() => onUse('请介绍你可以如何协助我。')}>
          直接对话
        </PillButton>
        <PillButton onClick={onToggle}>{selected ? '取消选用' : '选用'}</PillButton>
        {onRemove ? <PillButton onClick={onRemove}>删除</PillButton> : null}
      </div>
    </div>
  );
}

function connectorStatusText(c: ConnectorView): string {
  if (c.status === 'untrusted') return '待信任 · 添加后还没有启动';
  if (c.status === 'connected')
    return c.toolCount !== undefined ? `已连接 · ${c.toolCount} 个工具` : '已连接';
  if (c.status === 'needs-auth') return '待授权';
  if (c.status === 'failed') return c.failureSummary ?? '启动失败';
  if (c.status === 'disabled') return c.disabledReason ?? '已禁用';
  return '已信任，尚未在本次会话里握手';
}

function statusBadge(c: ConnectorView): string {
  if (c.status === 'untrusted') return '待信任';
  if (c.status === 'connected') return '已连接';
  if (c.status === 'needs-auth') return '待授权';
  if (c.status === 'failed') return '启动失败';
  if (c.status === 'disabled') return '已禁用';
  return '已信任';
}

export const SKILL_CREATOR_PROMPT =
  '帮我写一个新技能。先确认它要解决的重复任务和必要权限；完成后放到当前项目的 .agents/skills 目录，校验并告诉我精确路径。';

/* ── 插件 Hub（13 §5.6）─────────────────────────────────────────────────── */

const HUB_STATE_LABEL: Readonly<Record<HubEntryView['state'], string>> = {
  available: '未安装',
  installed: '已安装',
  'needs-reconfirm': '有更新，需重新确认',
  revoked: '已吊销',
  'needs-app-update': '需要更新 EvoWork',
  expired: '目录已过期',
};

/**
 * 顶栏右上角「精选目录」状态入口与弹层。
 *
 * 正常态把时间戳与未开启说明收进弹层，保持首屏整洁；
 * 异常态（目录过期 / 校验或网络警告）仍由主区顶部 Banner 常驻展示。
 */
function HubStatusControl({
  hub,
  open,
  onToggle,
  onClose,
  onRefresh,
  onOpenSettings,
}: {
  readonly hub: HubCatalogView;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onOpenSettings?: (() => void) | undefined;
}) {
  const status = hub.status;
  const isDisabled =
    status.fetchMode === 'off' ||
    status.fetchMode === 'org-off' ||
    status.fetchMode === 'unconfigured' ||
    (status.fetchMode === 'manual-only' && status.fetchedAt === undefined);

  const dotTone: 'accent' | 'warning' | 'muted' =
    status.expired || status.warning !== undefined ? 'warning' : isDisabled ? 'muted' : 'accent';

  const triggerLabel = status.expired
    ? '目录已过期'
    : status.warning !== undefined
      ? '目录异常'
      : isDisabled
        ? '精选未开启'
        : '精选目录';

  const statusText = status.expired
    ? '已过期'
    : status.warning !== undefined
      ? '状态异常'
      : isDisabled
        ? '未开启'
        : '正常';

  const hasMeta =
    status.fetchedAt !== undefined ||
    status.issuedAt !== undefined ||
    status.expiresAt !== undefined;

  return (
    <span className="ew-catalog-hub-anchor">
      <button
        type="button"
        className="ew-ghost-button ew-catalog-hub-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={onToggle}
      >
        <StatusDot tone={dotTone} />
        <span>{triggerLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>

      <Popover open={open} onClose={onClose} align="end">
        <div className="ew-catalog-hub-popover" role="dialog" aria-label="精选目录状态">
          <div className="ew-catalog-hub-head">
            <span className="ew-catalog-hub-title">
              <StatusDot tone={dotTone} />
              <span>
                {status.sourceName} · {statusText}
              </span>
            </span>
            {status.canRefresh ? (
              <PillButton icon="↻" onClick={onRefresh}>
                刷新
              </PillButton>
            ) : null}
          </div>
          <p className="ew-catalog-hub-note">
            {status.caption ??
              (status.expired
                ? '当前签名目录已超过有效期，暂停安装新内容，已安装项不受影响。'
                : '已启用签名校验目录，安装与更新前自动做本地静态审计。')}
          </p>
          {hasMeta ? (
            <dl className="ew-catalog-hub-meta">
              {status.fetchedAt !== undefined ? (
                <>
                  <dt>最近检查</dt>
                  <dd>{formatHubTime(status.fetchedAt)}</dd>
                </>
              ) : null}
              {status.issuedAt !== undefined ? (
                <>
                  <dt>目录签发</dt>
                  <dd>{formatHubDate(status.issuedAt)}</dd>
                </>
              ) : null}
              {status.expiresAt !== undefined ? (
                <>
                  <dt>目录有效期至</dt>
                  <dd>{formatHubDate(status.expiresAt)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {status.fetchMode === 'manual-only' &&
          !status.signedIn &&
          !status.fetchWhenSignedOut &&
          onOpenSettings ? (
            <div className="ew-catalog-hub-actions">
              <PillButton variant="accent" onClick={onOpenSettings}>
                去设置开启
              </PillButton>
            </div>
          ) : null}
        </div>
      </Popover>
    </span>
  );
}

function HubGrid({
  entries,
  hasFilters,
  onClearFilters,
  hub,
  onRefresh,
  onOpenSettings,
  onGoInstalled,
  onInstall,
  onUninstall,
  onRollback,
}: {
  readonly entries: readonly HubEntryView[];
  readonly hasFilters: boolean;
  readonly onClearFilters?: (() => void) | undefined;
  readonly hub?: HubCatalogView | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly onOpenSettings?: (() => void) | undefined;
  readonly onGoInstalled: () => void;
  readonly onInstall: (ref: HubItemRef) => void;
  readonly onUninstall: (entry: HubEntryView) => void;
  readonly onRollback: (ref: HubItemRef) => void;
}) {
  const status = hub?.status;
  if (entries.length === 0) {
    if (hasFilters && onClearFilters) {
      return (
        <EmptyState
          title="没有匹配的精选插件"
          hint="可以清除搜索或分类筛选后再看。"
          action={<PillButton onClick={onClearFilters}>清除筛选</PillButton>}
        />
      );
    }

    if (!status || !status.configured) {
      return (
        <EmptyState
          title="精选目录尚未接入"
          hint={status?.caption ?? '当前版本尚未接入精选源，可使用本机已装内容或手动安装。'}
          action={<PillButton onClick={onGoInstalled}>查看我的已装</PillButton>}
        />
      );
    }

    if (status.fetchMode === 'manual-only' && status.fetchedAt === undefined) {
      return (
        <EmptyState
          title={`尚未开启 ${status.sourceName}`}
          hint={status.caption ?? '登录或在设置中开启后，可以获取 EvoWork 精选内容'}
          action={
            <div className="ew-catalog-detail-actions">
              {status.canRefresh && onRefresh ? (
                <PillButton variant="accent" onClick={onRefresh}>
                  刷新获取
                </PillButton>
              ) : null}
              {onOpenSettings ? <PillButton onClick={onOpenSettings}>去设置开启</PillButton> : null}
              <PillButton onClick={onGoInstalled}>查看我的已装</PillButton>
            </div>
          }
        />
      );
    }

    return (
      <EmptyState
        title={`${status.sourceName}里还没有这一类内容`}
        hint={
          status.caption ??
          (status.fetchedAt === undefined
            ? '还没有拿到目录。点右上角刷新获取一次。'
            : '换个分类看看。')
        }
        action={
          <div className="ew-catalog-detail-actions">
            {status.canRefresh && onRefresh ? (
              <PillButton variant="accent" onClick={onRefresh}>
                刷新目录
              </PillButton>
            ) : null}
            <PillButton onClick={onGoInstalled}>查看我的已装</PillButton>
          </div>
        }
      />
    );
  }

  return (
    <div className="ew-projects-grid">
      {entries.map((entry) => {
        const ref = { kind: entry.kind, id: entry.id };
        const version =
          entry.installedVersion !== undefined && entry.installedVersion !== entry.version
            ? `${entry.installedVersion} → ${entry.version}`
            : entry.version;
        const meta = [
          status?.sourceName ?? 'EvoWork 精选',
          entry.riskLabel,
          ...(entry.promptVisible ? [] : ['按需带入']),
          version,
        ].join(' · ');
        const badge =
          entry.state === 'available' ? (
            entry.isNew ? (
              <Badge variant="info">新上架</Badge>
            ) : undefined
          ) : (
            <Badge
              variant={
                entry.state === 'installed'
                  ? 'success'
                  : entry.state === 'revoked' || entry.state === 'needs-reconfirm'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {HUB_STATE_LABEL[entry.state]}
            </Badge>
          );

        return (
          <ItemCard
            key={`${entry.kind}:${entry.id}`}
            name={entry.displayName}
            description={
              entry.reason !== undefined
                ? `${entry.description}（${entry.reason}）`
                : entry.description
            }
            tone={entry.state === 'revoked' || entry.riskLevel === 'p2' ? 'warning' : 'default'}
            action={badge}
            footer={
              <>
                <span className="ew-catalog-card-meta" title={meta}>
                  {meta}
                </span>
                <span className="ew-catalog-card-actions">
                  <HubAction
                    entry={entry}
                    onInstall={() => onInstall(ref)}
                    onUninstall={() => onUninstall(entry)}
                    onRollback={() => onRollback(ref)}
                  />
                </span>
              </>
            }
          />
        );
      })}
    </div>
  );
}

function HubAction({
  entry,
  onInstall,
  onUninstall,
  onRollback,
}: {
  readonly entry: HubEntryView;
  readonly onInstall: () => void;
  readonly onUninstall: () => void;
  readonly onRollback: () => void;
}) {
  switch (entry.state) {
    case 'available':
      return (
        <PillButton variant="accent" onClick={onInstall}>
          安装
        </PillButton>
      );
    case 'needs-reconfirm':
      return (
        <>
          <PillButton variant="accent" onClick={onInstall}>
            重新确认并更新
          </PillButton>
          <PillButton onClick={onUninstall}>卸载</PillButton>
        </>
      );
    case 'installed':
      return (
        <>
          {entry.canRollback ? <PillButton onClick={onRollback}>回滚</PillButton> : null}
          <PillButton onClick={onUninstall}>卸载</PillButton>
        </>
      );
    case 'revoked':
      return <PillButton onClick={onUninstall}>卸载</PillButton>;
    case 'needs-app-update':
      return entry.installedVersion !== undefined ? (
        <PillButton onClick={onUninstall}>卸载</PillButton>
      ) : (
        <span className="ew-catalog-muted">需要更新 EvoWork</span>
      );
    case 'expired':
      return <span className="ew-catalog-muted">目录已过期，暂不能安装</span>;
  }
}

function formatHubTime(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatHubDate(sec: number): string {
  return `${String(new Date(sec * 1000).getFullYear())}-${formatHubTime(sec)}`;
}
