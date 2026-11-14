/**
 * 技能 · 连接器目录页（05）。
 *
 * 三 Tab 共用同一套标题栏骨架（SegmentedControl + 搜索 + 已安装筛选 + 添加）。
 * 数据全是宿主给的：这一层不读盘、不调内核。
 */
import { useRef, useState, type ReactNode } from 'react';

import type {
  CatalogBundleView,
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
import { Menu, Popover } from '../components/menu.js';
import { TextTabs } from '../components/panels.js';
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
} from '../components/primitives.js';
import { MailTrialPermissions, type CatalogMailTrial } from './mail-summary-trial.js';

export type CatalogTab = 'experts' | 'skills' | 'connectors';

/** 插件 Hub 的四个动作（13，H1）。宿主没注入时缺席，页面上没有「EvoWork 精选」。 */
export interface CatalogHubActions {
  readonly refresh: () => Promise<CatalogMutationResult>;
  readonly install: (
    input: HubItemRef & { acknowledge?: boolean; confirmName?: string },
  ) => Promise<CatalogMutationResult>;
  readonly uninstall: (ref: HubItemRef) => Promise<CatalogMutationResult>;
  readonly rollback: (ref: HubItemRef) => Promise<CatalogMutationResult>;
}

const HUB_KIND: Readonly<Record<CatalogTab, HubItemRef['kind']>> = {
  skills: 'skill',
  experts: 'expert',
  connectors: 'connector',
};

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
  }) => Promise<CatalogMutationResult>;
  readonly onUninstallSkill: (id: string) => Promise<CatalogMutationResult>;
  readonly onSetSkillEnabled: (input: {
    path: string;
    name: string;
    enabled: boolean;
  }) => Promise<CatalogMutationResult>;
  readonly onInstallBundle: (input: {
    marketplacePath: string;
    pluginName: string;
    acknowledge?: boolean;
    confirmName?: string;
  }) => Promise<CatalogMutationResult>;
  readonly onUninstallBundle: (pluginId: string) => Promise<CatalogMutationResult>;
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
  readonly onUsePrompt: (prompt: string) => void;
  readonly onWriteSkill: () => void;
  readonly hubActions?: CatalogHubActions | undefined;
  readonly mailTrial?: CatalogMailTrial | undefined;
}

type Pending =
  | { readonly kind: 'git' }
  | {
      readonly kind: 'audit';
      readonly skillId: string;
      readonly level: string;
      readonly findings: readonly string[];
      readonly worstCase?: string;
      readonly source:
        | { kind: 'file' | 'directory' | 'git'; path?: string; url?: string }
        | { kind: 'bundle'; marketplacePath: string; pluginName: string; pendingReview: boolean }
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
  const [query, setQuery] = useState('');
  const [showMailPermissions, setShowMailPermissions] = useState(false);
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [selectedExperts, setSelectedExperts] = useState(loadSelectedExperts);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [bundleTab, setBundleTab] = useState<'recommend' | 'bundles'>('recommend');
  const [featuredOffset, setFeaturedOffset] = useState(0);
  /** 5.6 的来源筛选：全部 / EvoWork 精选。 */
  const [hubOnly, setHubOnly] = useState(false);
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
    ref: HubItemRef & { acknowledge?: boolean; confirmName?: string },
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

  /** 套件安装同样先过审计（13 §9.1）：要人看的，转成确认卡，不在卡片上一键装完。 */
  const installBundle = async (input: {
    marketplacePath: string;
    pluginName: string;
  }): Promise<CatalogMutationResult> => {
    const result = await props.onInstallBundle(input);
    if (result.needsConfirm && result.audit) {
      const bundle = result.catalog.bundles?.find(
        (b) => b.marketplacePath === input.marketplacePath && b.pluginName === input.pluginName,
      );
      setPending({
        kind: 'audit',
        skillId: result.audit.skillId,
        level: result.audit.level,
        findings: result.audit.findings,
        ...(result.audit.worstCase !== undefined ? { worstCase: result.audit.worstCase } : {}),
        source: {
          kind: 'bundle',
          marketplacePath: input.marketplacePath,
          pluginName: input.pluginName,
          pendingReview: bundle?.pendingReview === true,
        },
      });
    }
    return result;
  };

  const data = props.data;
  const skills = data?.skills ?? [];
  const connectors = data?.connectors ?? [];
  const experts = data?.experts ?? [];

  const q = query.trim().toLowerCase();
  const hasFilters = q !== '' || ownedOnly || category !== undefined;
  const clearFilters = () => {
    setQuery('');
    setOwnedOnly(false);
    setCategory(undefined);
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

  const matchingSkills = skills.filter((skill) =>
    matchesQuery(q, skill.name, skill.description, skill.category, skill.sourceLabel),
  );
  const featuredPool = ownedOnly ? [] : matchingSkills.filter((skill) => skill.featured);
  const firstFeatured = featuredPool.length > 0 ? featuredOffset % featuredPool.length : 0;
  const featured = [
    ...featuredPool.slice(firstFeatured),
    ...featuredPool.slice(0, firstFeatured),
  ].slice(0, 3);
  const featuredKeys = new Set(featured.map(skillKey));
  const visibleSkills = matchingSkills.filter(
    (skill) =>
      !featuredKeys.has(skillKey(skill)) &&
      (!ownedOnly || skill.installed) &&
      (ownedOnly || category === undefined || skill.category === category),
  );
  const cats = [...new Set(skills.map((skill) => skill.category))].sort((a, b) =>
    a.localeCompare(b),
  );
  const visibleConnectors = connectors.filter(
    (connector) =>
      (!ownedOnly || connector.trusted) &&
      (category === undefined || category === connector.category) &&
      matchesQuery(q, connector.name, statusBadge(connector)),
  );
  const visibleExperts = experts.filter(
    (expert) =>
      (!ownedOnly || selectedExperts.has(expert.id)) &&
      matchesQuery(q, expert.name, expert.description, expert.category),
  );
  const hubEntries = (data?.hub?.entries ?? []).filter(
    (entry) =>
      entry.kind === HUB_KIND[props.tab] &&
      matchesQuery(q, entry.displayName, entry.description, entry.category),
  );

  const searchPlaceholder =
    props.tab === 'experts' ? '搜索专家' : props.tab === 'connectors' ? '搜索连接器' : '搜索技能';
  const filterLabel =
    props.tab === 'connectors'
      ? `已信任 ${connectors.filter((connector) => connector.trusted).length}`
      : props.tab === 'experts'
        ? `已选用 ${experts.filter((expert) => selectedExperts.has(expert.id)).length}`
        : `我已安装的 ${skills.filter((skill) => skill.installed).length}`;

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

  const mailTrial = props.mailTrial;
  const showMailTrial =
    mailTrial &&
    selected === null &&
    !hubOnly &&
    !ownedOnly &&
    ((props.tab === 'skills' &&
      (category === undefined || category === '效率工具') &&
      bundleTab === 'recommend' &&
      matchesQuery(q, '邮件摘要试用', '收件箱', '待办')) ||
      (props.tab === 'connectors' &&
        category === undefined &&
        matchesQuery(q, '邮件', '示例邮箱')));

  const mailTrialCard =
    showMailTrial && mailTrial ? (
      <ItemCard
        name={props.tab === 'skills' ? '邮件摘要试用' : '示例邮箱'}
        description={
          props.tab === 'skills' ? '用示例邮件生成重点和待办。' : '为邮件摘要试用提供只读访问。'
        }
        footer={
          <>
            <Badge variant={mailTrial.connected ? 'success' : 'neutral'}>
              {mailTrial.connected ? '已连接' : '未连接'}
            </Badge>
            <PillButton variant="accent" onClick={() => setShowMailPermissions(true)}>
              查看权限
            </PillButton>
          </>
        }
      />
    ) : null;

  return (
    <div className="ew-page ew-catalog">
      {hubBusy ? <p role="status">正在安装技能并准备所需组件，请稍候…</p> : null}
      <div className="ew-page-title-bar ew-catalog-toolbar">
        <SegmentedControl
          variant="dark"
          ariaLabel="目录种类"
          value={props.tab}
          onChange={(id) => {
            props.onTab(id as CatalogTab);
            setSelected(null);
            clearFilters();
            setHubOnly(false);
            setBundleTab('recommend');
            setFeaturedOffset(0);
            setAddOpen(false);
          }}
          items={[
            { id: 'skills', label: '技能' },
            { id: 'connectors', label: '连接器' },
            { id: 'experts', label: 'EvoWork 专家' },
          ]}
        />
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={searchPlaceholder}
          ariaLabel={searchPlaceholder}
        />
        {!hubOnly && (props.tab !== 'skills' || bundleTab === 'recommend') ? (
          <GhostButton
            label={filterLabel}
            pressed={ownedOnly}
            icon={ownedOnly ? '☑' : '☐'}
            onClick={() => setOwnedOnly((v) => !v)}
          />
        ) : null}
        {props.tab === 'skills' ? (
          <span className="ew-catalog-add">
            <PillButton variant="accent" onClick={() => setAddOpen((v) => !v)}>
              ＋ 添加技能
            </PillButton>
            <Popover open={addOpen} onClose={() => setAddOpen(false)} align="end">
              <Menu
                ariaLabel="添加技能"
                items={[
                  ...(props.onPickSkillFile ? [{ id: 'file', label: '从 SKILL.md 文件安装' }] : []),
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

      <div className="ew-content-column">
        {props.refusal ? <p className="ew-projects-refusal">{props.refusal}</p> : null}
        {data?.hub && props.hubActions && selected === null ? (
          <HubBar
            hub={data.hub}
            hubOnly={hubOnly}
            onHubOnly={(value) => {
              setHubOnly(value);
              setOwnedOnly(false);
              setCategory(undefined);
            }}
            onRefresh={() => void props.hubActions?.refresh()}
          />
        ) : null}
        {props.tab === 'skills' && data?.skillBudget?.over ? (
          <Banner tone="warning">
            <p>
              {data.skillBudget.warning ?? '已启用技能的目录预计超出预算，部分说明可能被缩短或省略'}
            </p>
            <p>
              目录估算占用 {data.skillBudget.used.toLocaleString('zh-CN')} /{' '}
              {data.skillBudget.budget.toLocaleString('zh-CN')}{' '}
              token（按最小支持窗口估算）。可停用不常用的技能，实际可见内容取决于所用模型。
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

        {showMailTrial && props.tab === 'skills' && !hasFilters ? (
          <div className="ew-catalog-trial-callout">
            <div>
              <h2>试用邮件摘要</h2>
              <p>查看读取权限，连接示例邮箱，再到任务里生成摘要。</p>
            </div>
            <PillButton variant="accent" onClick={() => setShowMailPermissions(true)}>
              开始试用
            </PillButton>
          </div>
        ) : null}

        {selectedSkill ? (
          <SkillDetail
            skill={selectedSkill}
            onBack={() => setSelected(null)}
            onUse={() => {
              if (selectedSkill.defaultPrompt) props.onUsePrompt(selectedSkill.defaultPrompt);
            }}
            onSetEnabled={
              selectedSkill.skillPath
                ? (enabled) =>
                    void props.onSetSkillEnabled({
                      path: selectedSkill.skillPath!,
                      name: selectedSkill.id,
                      enabled,
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
            onUse={(prompt) => props.onUsePrompt(prompt)}
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
        ) : hubOnly && data?.hub && props.hubActions ? (
          <HubGrid
            entries={hubEntries}
            onClearSearch={q ? clearFilters : undefined}
            status={data.hub.status}
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
            trialCard={mailTrialCard}
            featured={featured}
            canShuffle={featuredPool.length > featured.length}
            ownedOnly={ownedOnly}
            onClearFilters={hasFilters ? clearFilters : undefined}
            visible={visibleSkills}
            cats={cats}
            category={category}
            onCategory={setCategory}
            bundleTab={bundleTab}
            onBundleTab={(tab) => {
              setBundleTab(tab);
              setOwnedOnly(false);
              setCategory(undefined);
            }}
            onShuffle={() => setFeaturedOffset((n) => n + 1)}
            query={query}
            onSelect={(id) => setSelected({ kind: 'skill', id })}
            onWrite={props.onWriteSkill}
            bundles={(data?.bundles ?? []).filter((bundle) =>
              matchesQuery(q, bundle.name, bundle.description, bundle.category),
            )}
            bundleErrors={data?.bundleErrors ?? []}
            onInstallBundle={installBundle}
            onUninstallBundle={(bundle) =>
              setPending({
                kind: 'uninstall-package',
                name: bundle.name,
                uninstall: () => void props.onUninstallBundle(bundle.id),
              })
            }
          />
        ) : props.tab === 'connectors' ? (
          <ConnectorsGrid
            trialCard={mailTrialCard}
            rows={visibleConnectors}
            onClearFilters={hasFilters ? clearFilters : undefined}
            query={query}
            category={category}
            onCategory={setCategory}
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
            onSelect={(id) => setSelected({ kind: 'expert', id })}
            onCreate={() => setPending({ kind: 'expert' })}
          />
        )}
      </div>

      {showMailPermissions && mailTrial ? (
        <MailTrialPermissions
          connected={mailTrial.connected}
          onClose={() => setShowMailPermissions(false)}
          onConnect={() => mailTrial.onConnectionChange(true)}
          onContinue={() => {
            setShowMailPermissions(false);
            mailTrial.onOpenTask();
          }}
          onDisconnect={() => {
            mailTrial.onConnectionChange(false);
            setShowMailPermissions(false);
          }}
        />
      ) : null}

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
              ? pending.source.kind === 'bundle'
                ? '高风险套件'
                : pending.source.kind === 'hub'
                  ? '高风险内容'
                  : '高风险技能'
              : pending.level === 'p1'
                ? '安装前请确认'
                : pending.source.kind === 'bundle'
                  ? '安装套件'
                  : '安装技能'
          }
          confirmLabel={
            pending.source.kind === 'bundle' && pending.source.pendingReview ? '启用' : '安装'
          }
          variant={pending.level === 'p2' ? 'danger' : 'default'}
          confirmDisabled={
            (pending.level === 'p1' && !ack) ||
            (pending.level === 'p2' && confirmName.trim() !== pending.skillId)
          }
          onCancel={() => {
            const source = pending.source;
            closeDialog();
            // git / npm 套件此时已经以停用状态装上了（HUB-Q8a=B）：不要它，就卸掉，不留半装的东西
            if (source.kind === 'bundle' && source.pendingReview) {
              const bundle = props.data?.bundles?.find(
                (b) =>
                  b.marketplacePath === source.marketplacePath &&
                  b.pluginName === source.pluginName,
              );
              if (bundle) void props.onUninstallBundle(bundle.id);
            }
          }}
          onConfirm={() => {
            const source = pending.source;
            closeDialog();
            if (source.kind === 'hub') {
              void installHub({
                ...source.ref,
                acknowledge: true,
                ...(pending.level === 'p2' ? { confirmName: pending.skillId } : {}),
              });
              return;
            }
            if (source.kind === 'bundle') {
              void props.onInstallBundle({
                marketplacePath: source.marketplacePath,
                pluginName: source.pluginName,
                acknowledge: true,
                ...(pending.level === 'p2' ? { confirmName: pending.skillId } : {}),
              });
              return;
            }
            void props.onInstallSkill({
              kind: source.kind,
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
                : pending.source.kind === 'bundle' || pending.source.kind === 'hub'
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
              {pending.source.kind === 'file' ||
              pending.source.kind === 'directory' ||
              pending.source.kind === 'git'
                ? '技能名'
                : '名称'}
              「{pending.skillId}」确认
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

function SkillsGrid({
  trialCard,
  featured,
  canShuffle,
  ownedOnly,
  onClearFilters,
  visible,
  cats,
  category,
  onCategory,
  bundleTab,
  onBundleTab,
  onShuffle,
  query,
  onSelect,
  onWrite,
  bundles,
  bundleErrors,
  onInstallBundle,
  onUninstallBundle,
}: {
  readonly trialCard: ReactNode;
  readonly canShuffle: boolean;
  readonly ownedOnly: boolean;
  readonly onClearFilters?: (() => void) | undefined;
  readonly featured: readonly CatalogItemView[];
  readonly visible: readonly CatalogItemView[];
  readonly cats: readonly string[];
  readonly category: string | undefined;
  readonly onCategory: (id: string | undefined) => void;
  readonly bundleTab: 'recommend' | 'bundles';
  readonly onBundleTab: (id: 'recommend' | 'bundles') => void;
  readonly onShuffle: () => void;
  readonly query: string;
  readonly onSelect: (id: string) => void;
  readonly onWrite: () => void;
  readonly bundles: readonly CatalogBundleView[];
  readonly bundleErrors: readonly { readonly path: string; readonly message: string }[];
  readonly onInstallBundle: CatalogPageProps['onInstallBundle'];
  readonly onUninstallBundle: (bundle: CatalogBundleView) => void;
}) {
  if (bundleTab === 'bundles') {
    return (
      <>
        <TextTabs
          ariaLabel="技能分组"
          value={bundleTab}
          onChange={(id) => onBundleTab(id as 'recommend' | 'bundles')}
          items={[
            { id: 'recommend', label: '推荐' },
            { id: 'bundles', label: '套件' },
          ]}
        />
        {bundleErrors.map((error) => (
          <p key={`${error.path}:${error.message}`} className="ew-projects-refusal">
            {error.path}：{error.message}
          </p>
        ))}
        {bundles.length === 0 ? (
          <EmptyState
            title={query.trim() ? `没有找到「${query.trim()}」` : '还没有套件'}
            hint={query.trim() ? undefined : '套件可以包含多项技能、MCP 连接器与 hooks。'}
            action={
              onClearFilters ? (
                <PillButton onClick={onClearFilters}>清除搜索</PillButton>
              ) : undefined
            }
          />
        ) : (
          <div className="ew-projects-grid">
            {bundles.map((bundle) => (
              <ItemCard
                key={bundle.id}
                name={bundle.name}
                description={bundle.description}
                badges={[
                  ...(bundle.sourceLabel ? [bundle.sourceLabel] : []),
                  bundle.marketplaceName,
                  bundle.category,
                  ...(bundle.riskLabel ? [bundle.riskLabel] : []),
                  ...(bundle.version ? [bundle.version] : []),
                ]}
                tone={bundle.available && bundle.riskLevel !== 'p2' ? 'default' : 'warning'}
                footer={
                  <>
                    <Badge
                      variant={
                        bundle.pendingReview
                          ? 'warning'
                          : bundle.installed && bundle.enabled
                            ? 'success'
                            : 'neutral'
                      }
                    >
                      {bundle.pendingReview
                        ? '待确认'
                        : bundle.installed
                          ? bundle.enabled
                            ? '已启用'
                            : '已停用'
                          : '未安装'}
                    </Badge>
                    {bundle.pendingReview && bundle.marketplacePath ? (
                      <>
                        <PillButton
                          variant="accent"
                          onClick={() =>
                            void onInstallBundle({
                              marketplacePath: bundle.marketplacePath!,
                              pluginName: bundle.pluginName,
                            })
                          }
                        >
                          审查并启用
                        </PillButton>
                        <PillButton onClick={() => onUninstallBundle(bundle)}>卸载</PillButton>
                      </>
                    ) : bundle.installed ? (
                      <PillButton onClick={() => onUninstallBundle(bundle)}>卸载</PillButton>
                    ) : bundle.available && bundle.marketplacePath ? (
                      <PillButton
                        variant="accent"
                        onClick={() =>
                          void onInstallBundle({
                            marketplacePath: bundle.marketplacePath!,
                            pluginName: bundle.pluginName,
                          })
                        }
                      >
                        安装
                      </PillButton>
                    ) : (
                      <span className="ew-catalog-muted">
                        {bundle.disabledReason ?? '不可安装'}
                      </span>
                    )}
                  </>
                }
              />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {featured.length > 0 ? (
        <>
          <SectionHeader
            title="精选技能"
            actions={canShuffle ? <GhostButton label="换一换" onClick={onShuffle} /> : undefined}
          />
          <div className="ew-projects-grid">
            {featured.map((s) => (
              <SkillCard key={`feat-${skillKey(s)}`} skill={s} onSelect={onSelect} />
            ))}
          </div>
        </>
      ) : null}

      <TextTabs
        ariaLabel="技能分组"
        value={bundleTab}
        onChange={(id) => onBundleTab(id as 'recommend' | 'bundles')}
        items={[
          { id: 'recommend', label: '推荐' },
          { id: 'bundles', label: '套件' },
        ]}
      />

      {!ownedOnly && cats.length > 0 ? (
        <FilterChipRow ariaLabel="技能分类">
          <FilterChip
            label="全部"
            selected={category === undefined}
            onClick={() => onCategory(undefined)}
          />
          {cats.map((c) => (
            <FilterChip
              key={c}
              label={c}
              selected={category === c}
              onClick={() => onCategory(category === c ? undefined : c)}
            />
          ))}
        </FilterChipRow>
      ) : null}

      {visible.length === 0 && !trialCard ? (
        <EmptyState
          title={
            query.trim()
              ? featured.length
                ? '没有更多匹配的技能'
                : `没有找到「${query.trim()}」`
              : ownedOnly
                ? '还没有已安装的技能'
                : category !== undefined
                  ? '这个分类暂无推荐技能'
                  : featured.length
                    ? '没有更多推荐技能'
                    : '还没有可安装的技能'
          }
          hint={
            !onClearFilters && featured.length === 0
              ? '办公技能会随产品分发。若这里是空的，说明随包的 plugins/skills 没装上。'
              : undefined
          }
          action={
            onClearFilters ? (
              <div className="ew-catalog-detail-actions">
                <PillButton onClick={onClearFilters}>浏览全部技能</PillButton>
                {query.trim() && !ownedOnly && !featured.length ? (
                  <PillButton onClick={onWrite}>让 EvoWork 帮我写一个技能</PillButton>
                ) : null}
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="ew-projects-grid">
          {trialCard}
          {visible.map((s) => (
            <SkillCard key={skillKey(s)} skill={s} onSelect={onSelect} />
          ))}
        </div>
      )}
    </>
  );
}

function skillKey(skill: CatalogItemView): string {
  return skill.skillPath ?? skill.id;
}

function SkillCard({
  skill,
  onSelect,
}: {
  readonly skill: CatalogItemView;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <ItemCard
      name={skill.name}
      description={skill.description}
      badges={[skill.sourceLabel, skill.riskLabel]}
      tone={skill.riskLevel === 'p2' ? 'warning' : 'default'}
      footer={
        <>
          <Badge variant={skill.installed && skill.enabled !== false ? 'success' : 'neutral'}>
            {skill.installed ? (skill.enabled === false ? '已停用' : '已安装') : '未安装'}
          </Badge>
          <PillButton
            ariaLabel={`${skill.installed ? '管理' : '查看详情'} · ${skill.name}`}
            onClick={() => onSelect(skillKey(skill))}
          >
            {skill.installed ? '管理' : '查看详情'}
          </PillButton>
        </>
      }
    />
  );
}

function ConnectorsGrid({
  trialCard,
  onClearFilters,
  rows,
  query,
  category,
  onCategory,
  onSelect,
  onAdd,
}: {
  readonly onClearFilters?: (() => void) | undefined;
  readonly trialCard: ReactNode;
  readonly rows: readonly ConnectorView[];
  readonly query: string;
  readonly category: string | undefined;
  readonly onCategory: (id: string | undefined) => void;
  readonly onSelect: (id: string) => void;
  readonly onAdd: () => void;
}) {
  return (
    <>
      <p className="ew-catalog-caption">
        本版支持通过 MCP 协议接入任意第三方服务。官方连接器目录将在后续版本提供。
      </p>
      <FilterChipRow ariaLabel="连接器分类">
        <FilterChip
          label="全部"
          selected={category === undefined}
          onClick={() => onCategory(undefined)}
        />
        <FilterChip
          label="浏览器"
          selected={category === 'browser'}
          onClick={() => onCategory(category === 'browser' ? undefined : 'browser')}
        />
        <FilterChip
          label="自建"
          selected={category === 'custom'}
          onClick={() => onCategory(category === 'custom' ? undefined : 'custom')}
        />
      </FilterChipRow>
      {rows.length === 0 && !trialCard ? (
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
          {trialCard}
          {rows.map((c) => (
            <ItemCard
              key={c.id}
              name={c.name}
              description={connectorStatusText(c)}
              badges={[
                c.kind === 'official' ? '官方内置' : c.kind === 'hub' ? 'EvoWork 精选' : '自建',
              ]}
              tone={c.status === 'failed' || c.status === 'disabled' ? 'warning' : 'default'}
              footer={
                <>
                  <Badge
                    variant={
                      c.status === 'connected'
                        ? 'success'
                        : c.status === 'failed'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {statusBadge(c)}
                  </Badge>
                  <PillButton
                    ariaLabel={`${c.status === 'needs-auth' || !c.trusted ? '查看权限' : '管理'} · ${c.name}`}
                    onClick={() => onSelect(c.id)}
                  >
                    {c.status === 'needs-auth' || !c.trusted ? '查看权限' : '管理'}
                  </PillButton>
                </>
              }
            />
          ))}
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
  onSelect,
  onCreate,
}: {
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onClearFilters?: (() => void) | undefined;
  readonly rows: readonly CatalogExpertView[];
  readonly query: string;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={
          query.trim()
            ? `没有找到「${query.trim()}」`
            : onClearFilters
              ? '还没有已选用的专家'
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
      {rows.map((e) => (
        <ItemCard
          key={e.id}
          name={e.name}
          description={e.description}
          badges={[e.category, e.source === 'official' ? '官方内置' : '本地目录']}
          footer={
            <>
              <Badge variant={selected.has(e.id) ? 'success' : 'neutral'}>
                {selected.has(e.id) ? '已选用' : '未选用'}
              </Badge>
              <PillButton
                ariaLabel={`${selected.has(e.id) ? '取消选用' : '选用'} · ${e.name}`}
                onClick={() => onToggle(e.id)}
              >
                {selected.has(e.id) ? '取消选用' : '选用'}
              </PillButton>
              <PillButton
                ariaLabel={`查看详情 · ${e.name}`}
                variant="ghost"
                onClick={() => onSelect(e.id)}
              >
                查看详情
              </PillButton>
            </>
          }
        />
      ))}
    </div>
  );
}

function SkillDetail({
  skill,
  onBack,
  onUse,
  onUninstall,
  onSetEnabled,
}: {
  readonly skill: CatalogItemView;
  readonly onBack: () => void;
  readonly onUse: () => void;
  readonly onUninstall?: (() => void) | undefined;
  readonly onSetEnabled?: ((enabled: boolean) => void) | undefined;
}) {
  return (
    <div className="ew-catalog-detail">
      <GhostButton label="返回目录" onClick={onBack} />
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
      {skill.skillPath ? <p className="ew-catalog-detail-meta">位置：{skill.skillPath}</p> : null}
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
      <GhostButton label="返回目录" onClick={onBack} />
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
      <GhostButton label="返回目录" onClick={onBack} />
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
              <PillButton key={t} onClick={() => onUse(`请以「${expert.name}」的身份：${t}`)}>
                {t}
              </PillButton>
            ))}
          </div>
        </>
      ) : null}
      <div className="ew-catalog-detail-actions">
        <PillButton
          variant="accent"
          onClick={() => onUse(`请以「${expert.name}」的身份协助完成接下来的任务。`)}
        >
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
 * 「EvoWork 精选」的状态条 + 来源筛选。
 *
 * warning（校验失败丢弃 / 连不上用缓存）与 caption（为什么只有随包内容）都**常驻**，
 * 不是一闪而过的 Toast —— 「不静默降级」（5.6）。到期提示依据签名正文中的 expiresAt。
 */
function HubBar({
  hub,
  hubOnly,
  onHubOnly,
  onRefresh,
}: {
  readonly hub: HubCatalogView;
  readonly hubOnly: boolean;
  readonly onHubOnly: (value: boolean) => void;
  readonly onRefresh: () => void;
}) {
  const status = hub.status;
  return (
    <>
      {status.warning !== undefined ? <Banner tone="warning">{status.warning}</Banner> : null}
      {status.expired ? (
        <Banner tone="warning">
          {status.sourceName}目录已
          {status.expiresAt !== undefined ? `于 ${formatHubDate(status.expiresAt)} ` : ''}
          过期，暂时不能安装新内容。
          {status.fetchMode === 'offline'
            ? '请更新离线内容包。'
            : '服务器尚未提供有效的新目录，需要维护者更新。'}
          已安装内容可继续使用。
        </Banner>
      ) : null}
      {status.caption !== undefined ? (
        <p className="ew-catalog-muted" role="status">
          {status.caption}
        </p>
      ) : null}
      <FilterChipRow ariaLabel="来源">
        <FilterChip label="全部来源" selected={!hubOnly} onClick={() => onHubOnly(false)} />
        <FilterChip label={status.sourceName} selected={hubOnly} onClick={() => onHubOnly(true)} />
        {status.fetchedAt !== undefined ? (
          <span className="ew-catalog-muted">最近检查 {formatHubTime(status.fetchedAt)}</span>
        ) : null}
        {status.issuedAt !== undefined ? (
          <span className="ew-catalog-muted">目录签发 {formatHubDate(status.issuedAt)}</span>
        ) : null}
        {status.expiresAt !== undefined ? (
          <span className="ew-catalog-muted">目录有效期至 {formatHubDate(status.expiresAt)}</span>
        ) : null}
        {status.canRefresh ? <GhostButton label="刷新" icon="↻" onClick={onRefresh} /> : null}
      </FilterChipRow>
    </>
  );
}

function HubGrid({
  entries,
  onClearSearch,
  status,
  onInstall,
  onUninstall,
  onRollback,
}: {
  readonly onClearSearch?: (() => void) | undefined;
  readonly entries: readonly HubEntryView[];
  readonly status: HubCatalogView['status'];
  readonly onInstall: (ref: HubItemRef) => void;
  readonly onUninstall: (entry: HubEntryView) => void;
  readonly onRollback: (ref: HubItemRef) => void;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        title={onClearSearch ? '没有匹配的精选插件' : `${status.sourceName}里还没有这一类内容`}
        action={
          onClearSearch ? <PillButton onClick={onClearSearch}>清除搜索</PillButton> : undefined
        }
        hint={
          status.caption ??
          (status.fetchedAt === undefined
            ? '还没有拿到目录。点「刷新」获取一次。'
            : '换个分类看看。')
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
        return (
          <ItemCard
            key={`${entry.kind}:${entry.id}`}
            name={entry.displayName}
            description={
              entry.reason !== undefined
                ? `${entry.description}（${entry.reason}）`
                : entry.description
            }
            badges={[
              status.sourceName,
              ...(entry.isNew ? ['新上架'] : []),
              entry.riskLabel,
              ...(entry.promptVisible ? [] : ['按需带入']),
              version,
            ]}
            tone={entry.state === 'revoked' || entry.riskLevel === 'p2' ? 'warning' : 'default'}
            footer={
              <>
                <Badge
                  variant={
                    entry.state === 'installed'
                      ? 'success'
                      : entry.state === 'revoked'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {HUB_STATE_LABEL[entry.state]}
                </Badge>
                <HubAction
                  entry={entry}
                  onInstall={() => onInstall(ref)}
                  onUninstall={() => onUninstall(entry)}
                  onRollback={() => onRollback(ref)}
                />
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
