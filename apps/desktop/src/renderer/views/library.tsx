/**
 * 资料库（06，截图 4 复刻）—— 与「任务」同级的一级入口。
 *
 * ```
 * ┌──────────┬──────────────┬────────────────────────────────┐
 * │ 侧边栏    │ 中栏 272     │ 主区                            │
 * │（复用）   │ 搜索/最近/   │ SegmentedControl 浅色 · 三 Tab  │
 * │          │ 本地产物     │ DataTable + TipBanner           │
 * │          │ 我的资料 ＋  │                                 │
 * │          │ 团队空间 ＋  │                                 │
 * │          │ QuotaFooter  │                                 │
 * └──────────┴──────────────┴────────────────────────────────┘
 * ```
 *
 * ## 「文件系统是真源」在这里是可见的
 *
 * 06 §3.2：资料库不是独立存储，只是本机文件的一个视图 + 索引。
 * 所以**两种删除的语义不同**，而且必须在确认框里说清 —— 写反了用户会丢文件。
 * 文案由 `@evowork/artifacts` 给（`describeDeleteMine` / `describeRemoveArtifact`），
 * 不在这里拼：拼在这里的话，改一处忘一处的概率是 100%。
 *
 * ## 「所有者」列会自动消失
 *
 * Q17/Q19 都不做的话，个人版里这一列恒为「我」。06 §3.3 的规则是
 * **当前视图内所有行的所有者相同时自动隐藏该列** —— 留着就是一整列废信息。
 */
import { useMemo, useState } from 'react';

import {
  CLEANUP_HINT,
  describeDeleteMine,
  describeDiskUsage,
  describeRemoveArtifact,
  filterRows,
  RECENT_TABS,
  shouldShowOwnerColumn,
  TYPE_FILTER_LABEL,
  type DiskUsage,
  type LibraryRow,
  type RecentTab,
  type TypeFilter,
} from '@evowork/artifacts';

import {
  DataTable,
  PanelHeader,
  PanelNavItem,
  TipBanner,
  TreeItem,
  TreeSectionHeader,
  type Column,
} from '../components/panels.js';
import {
  Badge,
  EmptyState,
  IconButton,
  PillButton,
  QuotaFooter,
  SearchInput,
  SegmentedControl,
} from '../components/primitives.js';
import { InlineSelect } from '../components/menu.js';

export type LibraryNav = 'search' | 'recent' | 'artifacts';

export interface ShareRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly expiresLabel: string;
  readonly expiringSoon: boolean;
  readonly accessCount: number;
}

export interface LibraryTreeNode {
  readonly id: string;
  readonly label: string;
  readonly icon?: string | undefined;
  readonly depth?: number | undefined;
}

export interface LibraryProps {
  readonly rows: readonly LibraryRow[];
  readonly shares?: readonly ShareRow[] | undefined;
  readonly myFiles?: readonly LibraryTreeNode[] | undefined;
  readonly teamSpaces?: readonly LibraryTreeNode[] | undefined;
  readonly diskUsage?: DiskUsage | undefined;
  readonly onOpen?: ((row: LibraryRow) => void) | undefined;
  readonly onDelete?: ((row: LibraryRow, alsoDeleteFile: boolean) => void) | undefined;
  readonly onRevokeShare?: ((shareId: string) => void) | undefined;
  readonly onCleanup?: (() => void) | undefined;
  readonly onAddMyFile?: (() => void) | undefined;
  readonly onSubscribeTeam?: (() => void) | undefined;
  readonly tipDismissed?: boolean | undefined;
  readonly onDismissTip?: (() => void) | undefined;
}

const TYPE_FILTERS: readonly TypeFilter[] = [
  'all',
  'document',
  'spreadsheet',
  'presentation',
  'pdf',
  'image',
  'markdown',
  'data',
  'other',
];

export function Library(props: LibraryProps) {
  const [nav, setNav] = useState<LibraryNav>('recent');
  const [tab, setTab] = useState<RecentTab>('recent');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [pendingDelete, setPendingDelete] = useState<LibraryRow | null>(null);
  const [alsoDeleteFile, setAlsoDeleteFile] = useState(false);

  const scoped = useMemo(
    () => (nav === 'artifacts' ? props.rows.filter((r) => r.source === 'artifact') : props.rows),
    [props.rows, nav],
  );
  const rows = useMemo(() => filterRows(scoped, { filter, query }), [scoped, filter, query]);
  const showOwner = shouldShowOwnerColumn(rows);

  const columns: Column<LibraryRow>[] = [
    {
      id: 'name',
      header: '名称',
      render: (row) => (
        <span className="ew-library-name">
          <span aria-hidden="true">{iconFor(row)}</span>
          {row.name}
        </span>
      ),
      sortValue: (row) => row.name,
    },
    ...(showOwner
      ? [{ id: 'owner', header: '所有者', render: (row: LibraryRow) => row.owner }]
      : []),
    { id: 'location', header: '位置', render: (row) => row.location },
    {
      id: 'accessedAt',
      header: '最近访问',
      render: (row) => formatWhen(row.accessedAt),
      sortValue: (row) => row.accessedAt,
      align: 'end',
    },
  ];

  const usage = props.diskUsage ? describeDiskUsage(props.diskUsage) : undefined;

  return (
    <div className="ew-library">
      <nav className="ew-library-panel" aria-label="资料库导航">
        <PanelHeader title="资料库" actions={<IconButton label="资料库公告" icon="📣" />} />

        <PanelNavItem
          label="搜索"
          icon="⌕"
          selected={nav === 'search'}
          onClick={() => setNav('search')}
        />
        <PanelNavItem
          label="最近"
          icon="◷"
          selected={nav === 'recent'}
          onClick={() => setNav('recent')}
        />
        <PanelNavItem
          label="本地产物"
          icon="◈"
          selected={nav === 'artifacts'}
          onClick={() => setNav('artifacts')}
        />

        <TreeSectionHeader label="我的资料" onAdd={props.onAddMyFile} addLabel="添加资料" />
        {(props.myFiles ?? []).map((node) => (
          <TreeItem key={node.id} label={node.label} icon={node.icon} depth={node.depth ?? 0} />
        ))}

        <TreeSectionHeader label="团队空间" onAdd={props.onSubscribeTeam} addLabel="订阅团队空间" />
        {(props.teamSpaces ?? []).map((node) => (
          <TreeItem key={node.id} label={node.label} icon={node.icon} depth={node.depth ?? 0} />
        ))}
        {(props.teamSpaces ?? []).length === 0 ? (
          // Q19：只读订阅。没订阅时说清它是只读的，避免用户以为能往里放东西
          <p className="ew-library-hint">团队空间是只读的：订阅之后可以查看，但不能改。</p>
        ) : null}

        {usage ? (
          <QuotaFooter
            usedLabel={usage.label}
            percent={usage.percent}
            onCleanup={props.onCleanup}
          />
        ) : null}
      </nav>

      <main className="ew-library-main" aria-label="资料库">
        <div className="ew-library-toolbar">
          <h1 className="ew-library-title">{NAV_TITLE[nav]}</h1>
          {nav === 'search' ? (
            <SearchInput
              ariaLabel="搜索资料"
              placeholder="搜索文件名与正文"
              value={query}
              onChange={setQuery}
            />
          ) : null}
          {nav === 'recent' ? (
            <SegmentedControl
              variant="light"
              ariaLabel="最近视图"
              value={tab}
              items={RECENT_TABS.map((t) => ({ id: t.id, label: t.label }))}
              onChange={(id) => setTab(id as RecentTab)}
            />
          ) : null}
          <span className="ew-library-filter">
            <InlineSelect
              ariaLabel="类型筛选"
              placeholder={TYPE_FILTER_LABEL.all}
              value={filter}
              options={TYPE_FILTERS.map((id) => ({ id, label: TYPE_FILTER_LABEL[id] }))}
              onChange={(id) => setFilter(id as TypeFilter)}
            />
          </span>
        </div>

        {nav === 'recent' && tab === 'shared-by-me' ? (
          <SharesTable shares={props.shares ?? []} onRevoke={props.onRevokeShare} />
        ) : (
          <DataTable
            ariaLabel="资料列表"
            columns={columns}
            rows={rows}
            onRowClick={props.onOpen}
            rowActions={(row) => (
              <IconButton
                label={`删除 ${row.name}`}
                icon="🗑"
                onClick={() => {
                  setPendingDelete(row);
                  setAlsoDeleteFile(false);
                }}
              />
            )}
            emptyState={
              <EmptyState
                title={query ? '没有匹配的资料' : '这里还没有东西'}
                hint={
                  query
                    ? '换个词试试，或者把类型筛选放宽。'
                    : '任务生成的产物会自动出现在「本地产物」里；也可以把文件拖进「我的资料」。'
                }
              />
            }
          />
        )}

        {!props.tipDismissed ? (
          <TipBanner
            title="资料库能帮你做什么"
            icon="◆"
            cards={[
              {
                title: '产物自动归集',
                body: '任务生成的文档、表格、幻灯片会自动进「本地产物」，跨任务也能找到。',
              },
              {
                title: '全文搜索在本机',
                body: '搜索覆盖文件名与正文，索引建在本机，内容不出网。',
              },
            ]}
            onDismiss={props.onDismissTip}
          />
        ) : null}

        {usage ? <p className="ew-library-hint">{CLEANUP_HINT}</p> : null}
      </main>

      {pendingDelete ? (
        <DeleteDialog
          row={pendingDelete}
          alsoDeleteFile={alsoDeleteFile}
          onToggleAlsoDelete={setAlsoDeleteFile}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            props.onDelete?.(pendingDelete, alsoDeleteFile);
            setPendingDelete(null);
          }}
        />
      ) : null}
    </div>
  );
}

const NAV_TITLE: Readonly<Record<LibraryNav, string>> = {
  search: '搜索',
  recent: '最近',
  artifacts: '本地产物',
};

/**
 * 删除确认。**两种语义由 `@evowork/artifacts` 给文案**（见文件头）。
 *
 * 「同时删除磁盘文件」这个勾选框只在「本地产物」出现，且**默认不勾** ——
 * 默认勾上等于把"移除索引"悄悄变成"删文件"。
 */
function DeleteDialog({
  row,
  alsoDeleteFile,
  onToggleAlsoDelete,
  onCancel,
  onConfirm,
}: {
  readonly row: LibraryRow;
  readonly alsoDeleteFile: boolean;
  readonly onToggleAlsoDelete: (value: boolean) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const intent =
    row.source === 'artifact'
      ? describeRemoveArtifact(row.name, row.location)
      : describeDeleteMine(row.name);

  return (
    <div className="ew-delete-confirm" role="alertdialog" aria-label={intent.title}>
      <p className="ew-delete-confirm-title">{intent.title}</p>
      <p className="ew-delete-confirm-body">{intent.body}</p>
      {intent.offersFileDeletion ? (
        <label className="ew-delete-also">
          <input
            type="checkbox"
            checked={alsoDeleteFile}
            onChange={(event) => onToggleAlsoDelete(event.target.checked)}
          />
          同时删除磁盘上的文件
        </label>
      ) : null}
      <PillButton onClick={onCancel}>取消</PillButton>
      <PillButton variant="accent" onClick={onConfirm}>
        {intent.kind === 'delete-file' ? '删除文件' : '从资料库移除'}
      </PillButton>
    </div>
  );
}

/** 「我分享的」：链接 + 有效期倒计时 + 访问次数 + 撤销（06 §3.3 / 08 §7.2）。 */
function SharesTable({
  shares,
  onRevoke,
}: {
  readonly shares: readonly ShareRow[];
  readonly onRevoke?: ((shareId: string) => void) | undefined;
}) {
  const columns: Column<ShareRow>[] = [
    { id: 'name', header: '产物', render: (row) => row.name, sortValue: (row) => row.name },
    {
      id: 'expires',
      header: '有效期',
      render: (row) => (
        <Badge variant={row.expiringSoon ? 'warning' : 'neutral'}>{row.expiresLabel}</Badge>
      ),
    },
    { id: 'access', header: '访问次数', render: (row) => row.accessCount, align: 'end' },
  ];
  return (
    <DataTable
      ariaLabel="我分享的"
      columns={columns}
      rows={shares}
      rowActions={(row) => (
        // 撤销即云端删除 + 链接失效（08 §7.2 规则 3）
        <PillButton variant="ghost" onClick={() => onRevoke?.(row.id)}>
          撤销分享
        </PillButton>
      )}
      emptyState={
        <EmptyState
          title="还没有分享过东西"
          hint="产物卡上的「分享」会先问你一次授权，链接有有效期，随时可以撤销。"
        />
      }
    />
  );
}

const TYPE_ICON: Readonly<Record<string, string>> = {
  document: '📄',
  spreadsheet: '📊',
  presentation: '📽',
  pdf: '📕',
  chart: '📈',
  image: '🖼',
  data: '🗄',
  archive: '🗜',
  webpage: '🌐',
};

function iconFor(row: LibraryRow): string {
  return TYPE_ICON[row.artifactType ?? ''] ?? '📄';
}

/** 相对时间。资料库里"三天前"比一个完整时间戳有用得多。 */
export function formatWhen(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(at).toISOString().slice(0, 10);
}
