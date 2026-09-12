/**
 * 技能 · 连接器目录页（05）。
 *
 * 三 Tab 共用同一套标题栏骨架（SegmentedControl + 搜索 + 已安装筛选 + 添加）。
 * 数据全是宿主给的：这一层不读盘、不调内核。
 */
import { useMemo, useState } from 'react';

import type {
  CatalogAppView,
  CatalogDataView,
  CatalogExpertView,
  CatalogItemView,
  CatalogMutationResult,
  ConnectorView,
} from '../../shared/ipc.js';
import { Menu, Popover } from '../components/menu.js';
import { TextTabs } from '../components/panels.js';
import {
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

export type CatalogTab = 'experts' | 'skills' | 'connectors';

export interface CatalogPageProps {
  readonly data: CatalogDataView | null;
  readonly tab: CatalogTab;
  readonly onTab: (tab: CatalogTab) => void;
  readonly refusal?: string | undefined;
  readonly onInstallSkill: (input: {
    kind: 'directory' | 'git';
    path?: string;
    url?: string;
    acknowledge?: boolean;
    confirmName?: string;
  }) => Promise<CatalogMutationResult>;
  readonly onUninstallSkill: (id: string) => Promise<CatalogMutationResult>;
  readonly onAddConnector: (input: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string;
    url?: string;
  }) => Promise<CatalogMutationResult>;
  readonly onTrustConnector: (id: string) => Promise<CatalogMutationResult>;
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
  readonly onUsePrompt: (prompt: string) => void;
  readonly onWriteSkill: () => void;
}

type Pending =
  | { readonly kind: 'git' }
  | {
      readonly kind: 'audit';
      readonly skillId: string;
      readonly level: string;
      readonly findings: readonly string[];
      readonly worstCase?: string;
      readonly source: { kind: 'directory' | 'git'; path?: string; url?: string };
    }
  | { readonly kind: 'connector' }
  | { readonly kind: 'expert' }
  | { readonly kind: 'trust'; readonly connector: ConnectorView }
  | { readonly kind: 'uninstall-skill'; readonly id: string; readonly name: string }
  | { readonly kind: 'remove-expert'; readonly id: string; readonly name: string }
  | { readonly kind: 'remove-connector'; readonly id: string; readonly name: string }
  | null;

export function CatalogPage(props: CatalogPageProps) {
  const [query, setQuery] = useState('');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [bundleTab, setBundleTab] = useState<'recommend' | 'bundles'>('recommend');
  const [featuredOffset, setFeaturedOffset] = useState(0);
  const [selected, setSelected] = useState<
    | { readonly kind: 'skill'; readonly id: string }
    | { readonly kind: 'connector'; readonly id: string }
    | { readonly kind: 'expert'; readonly id: string }
    | null
  >(null);
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

  const data = props.data;
  const skills = data?.skills ?? [];
  const connectors = data?.connectors ?? [];
  const experts = data?.experts ?? [];

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (installedOnly && !s.installed) return false;
      if (category !== undefined && s.category !== category) return false;
      if (bundleTab === 'bundles') return false;
      if (q === '') return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q)
      );
    });
  }, [skills, query, installedOnly, category, bundleTab]);

  const featured = useMemo(() => {
    const pool = skills.filter((s) => s.featured);
    if (pool.length <= 3) return pool;
    const start = ((featuredOffset % pool.length) + pool.length) % pool.length;
    return [0, 1, 2].map((i) => pool[(start + i) % pool.length]).filter((s) => s !== undefined);
  }, [skills, featuredOffset]);

  const cats = useMemo(
    () => [...new Set(skills.map((s) => s.category))].sort((a, b) => a.localeCompare(b)),
    [skills],
  );

  const visibleConnectors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return connectors.filter((c) => {
      if (installedOnly && !c.trusted) return false;
      if (category === 'browser' && c.category !== 'browser') return false;
      if (category === 'custom' && c.category !== 'custom') return false;
      if (q === '') return true;
      return c.name.toLowerCase().includes(q);
    });
  }, [connectors, query, installedOnly, category]);

  const visibleExperts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return experts.filter((e) => {
      if (q === '') return true;
      return e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
    });
  }, [experts, query]);

  const searchPlaceholder =
    props.tab === 'experts' ? '搜索专家' : props.tab === 'connectors' ? '搜索连接器' : '搜索技能';
  const installedCount =
    props.tab === 'connectors'
      ? connectors.filter((c) => c.trusted).length
      : props.tab === 'experts'
        ? experts.length
        : skills.filter((s) => s.installed).length;
  const installedLabel =
    props.tab === 'connectors' ? `已连接 ${installedCount}` : `我已安装的 ${installedCount}`;

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
    selected?.kind === 'skill' ? skills.find((s) => s.id === selected.id) : undefined;
  const selectedConnector =
    selected?.kind === 'connector' ? connectors.find((c) => c.id === selected.id) : undefined;
  const selectedExpert =
    selected?.kind === 'expert' ? experts.find((e) => e.id === selected.id) : undefined;

  return (
    <div className="ew-page">
      <div className="ew-page-title-bar">
        <SegmentedControl
          variant="dark"
          ariaLabel="目录种类"
          value={props.tab}
          onChange={(id) => {
            props.onTab(id as CatalogTab);
            setSelected(null);
            setQuery('');
            setInstalledOnly(false);
            setCategory(undefined);
          }}
          items={[
            { id: 'experts', label: '专家' },
            { id: 'skills', label: '技能' },
            { id: 'connectors', label: '连接器' },
          ]}
        />
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={searchPlaceholder}
          ariaLabel={searchPlaceholder}
        />
        <GhostButton
          label={installedLabel}
          icon={installedOnly ? '☑' : '☐'}
          onClick={() => setInstalledOnly((v) => !v)}
        />
        {props.tab === 'skills' ? (
          <span className="ew-catalog-add">
            <PillButton variant="accent" onClick={() => setAddOpen((v) => !v)}>
              ＋ 添加技能
            </PillButton>
            <Popover open={addOpen} onClose={() => setAddOpen(false)} align="end">
              <Menu
                ariaLabel="添加技能"
                items={[
                  { id: 'dir', label: '从文件/目录安装' },
                  { id: 'git', label: '从 Git 安装' },
                  { id: 'write', label: '让 EvoWork 帮我写一个' },
                ]}
                onSelect={(id) => {
                  setAddOpen(false);
                  if (id === 'dir') {
                    void props.onPickDirectory().then(async (path) => {
                      if (path === undefined) return;
                      const result = await props.onInstallSkill({ kind: 'directory', path });
                      if (result.needsConfirm && result.audit) {
                        setPending({
                          kind: 'audit',
                          skillId: result.audit.skillId,
                          level: result.audit.level,
                          findings: result.audit.findings,
                          ...(result.audit.worstCase !== undefined
                            ? { worstCase: result.audit.worstCase }
                            : {}),
                          source: { kind: 'directory', path },
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

        {selectedSkill ? (
          <SkillDetail
            skill={selectedSkill}
            onBack={() => setSelected(null)}
            onUse={() => {
              if (selectedSkill.defaultPrompt) props.onUsePrompt(selectedSkill.defaultPrompt);
            }}
            onUninstall={
              selectedSkill.source === 'official'
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
        ) : props.tab === 'skills' ? (
          <SkillsGrid
            featured={featured}
            visible={visibleSkills}
            cats={cats}
            category={category}
            onCategory={setCategory}
            bundleTab={bundleTab}
            onBundleTab={setBundleTab}
            onShuffle={() => setFeaturedOffset((n) => n + 1)}
            query={query}
            onSelect={(id) => setSelected({ kind: 'skill', id })}
            onWrite={props.onWriteSkill}
          />
        ) : props.tab === 'connectors' ? (
          <ConnectorsGrid
            rows={visibleConnectors}
            query={query}
            category={category}
            onCategory={setCategory}
            onSelect={(id) => setSelected({ kind: 'connector', id })}
            onAdd={() => setPending({ kind: 'connector' })}
          />
        ) : (
          <ExpertsGrid
            rows={visibleExperts}
            query={query}
            onSelect={(id) => setSelected({ kind: 'expert', id })}
            onCreate={() => setPending({ kind: 'expert' })}
          />
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
              ? '高风险技能'
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
                : '高风险。输入技能名以确认你知道它能做什么最坏的事。'}
          </p>
          <ul className="ew-catalog-findings">
            {pending.findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {pending.worstCase ? <p className="ew-catalog-worst">{pending.worstCase}</p> : null}
          {pending.level === 'p1' ? (
            <label className="ew-dialog-field">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{' '}
              我已了解
            </label>
          ) : null}
          {pending.level === 'p2' ? (
            <label className="ew-dialog-field">
              输入技能名「{pending.skillId}」确认
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
  featured,
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
}: {
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
        <EmptyState
          title="还没有套件"
          hint="套件是包含多技能 / MCP / hooks 的分发单元。企业私有源下发后会出现在这里。"
        />
      </>
    );
  }

  return (
    <>
      {featured.length > 0 && query.trim() === '' ? (
        <>
          <SectionHeader
            title="精选技能"
            actions={<GhostButton label="换一换" onClick={onShuffle} />}
          />
          <div className="ew-projects-grid">
            {featured.map((s) => (
              <SkillCard key={`feat-${s.id}`} skill={s} onSelect={onSelect} />
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

      {cats.length > 0 ? (
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

      {visible.length === 0 ? (
        <EmptyState
          title={query.trim() === '' ? '还没有可安装的技能' : `没有找到「${query.trim()}」`}
          hint={
            query.trim() === ''
              ? '办公技能会随产品分发。若这里是空的，说明随包的 plugins/skills 没装上。'
              : undefined
          }
          action={
            query.trim() !== '' ? (
              <PillButton variant="accent" onClick={onWrite}>
                让 EvoWork 帮我写一个技能
              </PillButton>
            ) : undefined
          }
        />
      ) : (
        <div className="ew-projects-grid">
          {visible.map((s) => (
            <SkillCard key={s.id} skill={s} onSelect={onSelect} />
          ))}
        </div>
      )}
    </>
  );
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
      badges={[skill.sourceLabel, skill.riskLabel, skill.installed ? '已安装' : '未安装']}
      tone={skill.riskLevel === 'p2' ? 'warning' : 'default'}
      onClick={() => onSelect(skill.id)}
    />
  );
}

function ConnectorsGrid({
  rows,
  query,
  category,
  onCategory,
  onSelect,
  onAdd,
}: {
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
      {rows.length === 0 ? (
        <EmptyState
          title={query.trim() === '' ? '还没有连接器' : `没有找到「${query.trim()}」`}
          hint="本版只有 browser 这一个官方连接器。也可以添加自定义 MCP。"
          action={
            <PillButton variant="accent" onClick={onAdd}>
              ＋ 自定义连接器
            </PillButton>
          }
        />
      ) : (
        <div className="ew-projects-grid">
          {rows.map((c) => (
            <ItemCard
              key={c.id}
              name={c.name}
              description={connectorStatusText(c)}
              badges={[c.kind === 'official' ? '官方内置' : '自建', statusBadge(c)]}
              tone={c.status === 'failed' || c.status === 'disabled' ? 'warning' : 'default'}
              onClick={() => onSelect(c.id)}
              action={c.status === 'untrusted' ? <span>＋</span> : undefined}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ExpertsGrid({
  rows,
  query,
  onSelect,
  onCreate,
}: {
  readonly rows: readonly CatalogExpertView[];
  readonly query: string;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={query.trim() === '' ? '还没有专家' : `没有找到「${query.trim()}」`}
        hint="本期不预置角色包。新建一个，或把 agent-roles TOML 放到 ~/.evowork/agents/。"
        action={
          <PillButton variant="accent" onClick={onCreate}>
            ＋ 新建专家
          </PillButton>
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
          onClick={() => onSelect(e.id)}
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
}: {
  readonly skill: CatalogItemView;
  readonly onBack: () => void;
  readonly onUse: () => void;
  readonly onUninstall?: (() => void) | undefined;
}) {
  return (
    <div className="ew-catalog-detail">
      <GhostButton label="返回目录" onClick={onBack} />
      <h1 className="ew-catalog-detail-title">{skill.name}</h1>
      <p className="ew-catalog-detail-desc">{skill.description}</p>
      <p className="ew-catalog-detail-meta">
        {skill.sourceLabel} · {skill.riskLabel} · {skill.category}
      </p>
      {skill.findings.length > 0 ? (
        <ul className="ew-catalog-findings">
          {skill.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
      {skill.worstCase ? <p className="ew-catalog-worst">{skill.worstCase}</p> : null}
      <div className="ew-catalog-detail-actions">
        {skill.defaultPrompt ? (
          <PillButton variant="accent" onClick={onUse}>
            用它新建任务
          </PillButton>
        ) : null}
        {onUninstall ? (
          <PillButton onClick={onUninstall}>卸载</PillButton>
        ) : (
          <span className="ew-catalog-muted">官方内置技能不能卸载。</span>
        )}
      </div>
    </div>
  );
}

function ConnectorDetail({
  connector,
  onBack,
  onTrust,
  onRemove,
}: {
  readonly connector: ConnectorView;
  readonly onBack: () => void;
  readonly onTrust: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="ew-catalog-detail">
      <GhostButton label="返回目录" onClick={onBack} />
      <h1 className="ew-catalog-detail-title">{connector.name}</h1>
      <p className="ew-catalog-detail-desc">{connectorStatusText(connector)}</p>
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
      <div className="ew-catalog-detail-actions">
        {connector.trusted ? null : (
          <PillButton variant="accent" onClick={onTrust}>
            信任并启用
          </PillButton>
        )}
        <PillButton onClick={onRemove}>
          {connector.id === 'browser' ? '取消信任' : '移除'}
        </PillButton>
      </div>
    </div>
  );
}

function ExpertDetail({
  expert,
  onBack,
  onUse,
  onRemove,
}: {
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
  '请用 skill-creator 帮我写一个新技能。先问我这个技能要做什么、会读写哪些路径、要不要出网。写完把 SKILL.md 放到当前工作空间，不要执行里面的脚本。';

export function DiscoverDrawer(props: {
  readonly apps: readonly CatalogAppView[];
  readonly onClose: () => void;
  readonly onUse: (prompt: string) => void;
  readonly onManage: () => void;
}) {
  return (
    <div
      className="ew-discover-scrim"
      onClick={props.onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose();
      }}
      role="presentation"
    >
      <aside
        className="ew-discover-drawer"
        role="dialog"
        aria-label="使用插件"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ew-page-title-bar">
          <h1 className="ew-catalog-detail-title">使用插件</h1>
          <GhostButton label="关闭" onClick={props.onClose} />
        </div>
        {props.apps.length === 0 ? (
          <EmptyState
            title="还没有可用的插件"
            hint="安装技能、信任连接器或创建专家后，就能从这里使用。"
          />
        ) : (
          <div className="ew-projects-grid">
            {props.apps.map((app) => (
              <ItemCard
                key={app.id}
                name={app.displayName}
                description={app.description}
                badges={[app.category]}
                onClick={() =>
                  props.onUse(app.defaultPrompt ?? `使用「${app.displayName}」协助接下来的任务。`)
                }
              />
            ))}
          </div>
        )}
        <button type="button" className="ew-discover-manage" onClick={props.onManage}>
          管理插件 →
        </button>
      </aside>
    </div>
  );
}
