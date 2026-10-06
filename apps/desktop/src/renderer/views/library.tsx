import { FilePreview } from '../components/file-preview.js';
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
 * **走深路径 `/library.js` 而不是包的 barrel**：barrel 会把 `upload.ts` 一起拉进来，
 * 而那个文件顶上有 `node:crypto` —— 渲染进程是浏览器环境，vite 打包直接失败。
 * 这条在这一页被挂进 `app.tsx` 之前看不见（它从没进过渲染层的 bundle）。
 * 不在这里拼：拼在这里的话，改一处忘一处的概率是 100%。
 *
 * ## 「所有者」列会自动消失
 *
 * Q17/Q19 都不做的话，个人版里这一列恒为「我」。06 §3.3 的规则是
 * **当前视图内所有行的所有者相同时自动隐藏该列** —— 留着就是一整列废信息。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryActions, LibraryDataView, LibraryDocumentInput } from '../../shared/ipc.js';

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
} from '@evowork/artifacts/library.js';

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
  Dialog,
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
  /** 已撤销 / 已过期的也列出来 —— 用户来这一页多半就是查"到底撤没撤" */
  readonly state: 'active' | 'expiring-soon' | 'expired' | 'revoked';
  readonly hasPassword: boolean;
}

export interface LibraryTreeNode {
  readonly id: string;
  readonly label: string;
  readonly icon?: string | undefined;
  readonly depth?: number | undefined;
}

export interface LibraryProps {
  readonly rows: readonly LibraryRow[];
  readonly data?: LibraryDataView | undefined;
  readonly actions?: LibraryActions | undefined;
  readonly onReference?: ((input: LibraryDocumentInput) => void) | undefined;
  /** 从全局搜索的「搜索文件」进入时直接落在搜索视图。 */
  readonly initialNav?: LibraryNav | undefined;
  readonly shares?: readonly ShareRow[] | undefined;
  readonly myFiles?: readonly LibraryTreeNode[] | undefined;
  readonly teamSpaces?: readonly LibraryTreeNode[] | undefined;
  readonly diskUsage?: DiskUsage | undefined;
  readonly onOpen?: ((row: LibraryRow) => void) | undefined;
  readonly onDelete?: ((row: LibraryRow, alsoDeleteFile: boolean) => void) | undefined;
  readonly onRevokeShare?: ((shareId: string) => void) | undefined;
  /** 分享是**过一次授权流**的入口，不是直接动作（Q10 规则 1） */
  readonly onShare?: ((row: LibraryRow) => void) | undefined;
  readonly onCopyShareLink?: ((url: string) => void) | undefined;
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
  const [nav, setNav] = useState<LibraryNav>(props.initialNav ?? 'recent');
  const [tab, setTab] = useState<RecentTab>('recent');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [pendingDelete, setPendingDelete] = useState<LibraryRow | null>(null);
  const [alsoDeleteFile, setAlsoDeleteFile] = useState(false);
  const [data, setData] = useState(props.data);
  const [searchRows, setSearchRows] = useState<LibraryDataView['rows'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<import('../../shared/ipc.js').FilePreviewView | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [project, setProject] = useState('all');
  const [thread, setThread] = useState('all');
  const [source, setSource] = useState<'all' | 'artifact' | 'mine'>('all');
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [ocrRuntime, setOcrRuntime] = useState<import('../../shared/ipc.js').OcrRuntimeView | null>(
    null,
  );
  const [installOcr, setInstallOcr] = useState(false);
  const [ocrRotation, setOcrRotation] = useState('auto');
  const [confirmUpdate, setConfirmUpdate] = useState<string | null>(null);
  const [confirmOcr, setConfirmOcr] = useState<string | null>(null);
  const generation = useRef(0);
  const pageRevision = useRef<number | null>(null);
  useEffect(() => {
    setData(props.data);
  }, [props.data]);
  const act = async (action: () => Promise<LibraryDataView>) => {
    try {
      setData(await action());
      setSearchRows(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '资料动作失败。');
    }
  };
  useEffect(() => {
    if (!props.actions) return;
    void props.actions
      .getOcrRuntime()
      .then(setOcrRuntime)
      .catch((error) => setMessage(error instanceof Error ? error.message : '组件状态读取失败。'));
    let active = true;
    const refresh = async () => {
      try {
        const next = await props.actions!.getLibrary();
        if (active) setData(next);
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : '资料状态读取失败。');
      }
    };
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [props.actions]);
  useEffect(() => {
    setOffset(0);
    pageRevision.current = null;
  }, [query, filter, source, project, thread]);
  useEffect(() => {
    const current = ++generation.current;
    if (!props.actions || !data?.bodySearchEnabled || nav !== 'search' || !query.trim()) {
      setSearchRows(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setMessage('');
    const timer = setTimeout(() => {
      void props
        .actions!.searchLibrary({
          query,
          generation: current,
          offset,
          typeFilter: filter,
          source,
          ...(project !== 'all' ? { projectId: project } : {}),
          ...(thread !== 'all' ? { threadId: thread } : {}),
        })
        .then((result) => {
          if (generation.current !== result.generation) return;
          if (offset && pageRevision.current !== result.revision) {
            setMessage('资料索引已更新，请从第一页重新搜索。');
            setOffset(0);
            pageRevision.current = null;
            return;
          }
          pageRevision.current = result.revision;
          setSearchRows(result.rows);
          setHasMore(result.hasMore);
        })
        .catch((error) => {
          if (generation.current === current)
            setMessage(error instanceof Error ? error.message : '搜索未完成。');
        })
        .finally(() => {
          if (generation.current === current) setBusy(false);
        });
    }, 250);
    return () => {
      ++generation.current;
      clearTimeout(timer);
      void props.actions?.cancelLibrarySearch();
    };
  }, [
    query,
    filter,
    source,
    project,
    thread,
    offset,
    nav,
    data?.bodySearchEnabled,
    data?.revision,
    props.actions,
  ]);
  const allRows = (data?.rows ?? props.rows) as readonly LibraryRow[];
  const details = (id: string) => (searchRows ?? data?.rows)?.find((row) => row.id === id);
  const open = (row: LibraryRow) => {
    const version = details(row.id)?.version;
    if (props.actions && version)
      void props.actions
        .openLibraryDocument({ documentId: row.id, version })
        .catch((error) => setMessage(error instanceof Error ? error.message : '打不开资料。'));
    else props.onOpen?.(row);
  };

  const scoped = useMemo(
    () => (nav === 'artifacts' ? allRows.filter((r) => r.source === 'artifact') : allRows),
    [allRows, nav],
  );
  const rows =
    searchRows && nav === 'search'
      ? (searchRows as readonly LibraryRow[])
      : filterRows(scoped, { filter, query });
  const showOwner = shouldShowOwnerColumn(rows);

  const columns: Column<LibraryRow>[] = [
    {
      id: 'name',
      header: '名称',
      render: (row) => (
        <span className="ew-library-name">
          <span aria-hidden="true">{iconFor(row)}</span>
          <span>
            {row.name}
            {details(row.id)?.state ? (
              <Badge variant="neutral">
                {STATE_LABEL[details(row.id)!.state!] ?? details(row.id)?.state}
              </Badge>
            ) : null}
            {details(row.id)?.total ? (
              <span>
                {' '}
                已处理 {details(row.id)?.completed ?? 0}/{details(row.id)?.total} 页
              </span>
            ) : null}
            {details(row.id)?.note ? (
              <span className="ew-library-hint">{details(row.id)?.note}</span>
            ) : null}
            {details(row.id)?.snippets?.map((snippet, index) => (
              <p key={index} className="ew-library-hint">
                <span>
                  {snippet.location} · {snippet.source === 'ocr' ? 'OCR' : '原文'}
                  {snippet.needsReview ? ' · 需核对' : ''}：
                </span>
                {highlightSegments(snippet.text, snippet.highlights).map((segment, i) =>
                  segment.highlight ? <mark key={i}>{segment.text}</mark> : segment.text,
                )}
                {props.actions && details(row.id)?.version ? (
                  <PillButton
                    variant="ghost"
                    onClick={() => {
                      void props
                        .actions!.readLibraryLocation({
                          documentId: row.id,
                          version: details(row.id)!.version!,
                          location: snippet.location,
                        })
                        .then(setPreview)
                        .catch((error) =>
                          setMessage(error instanceof Error ? error.message : '位置预览失败。'),
                        );
                    }}
                  >
                    打开位置
                  </PillButton>
                ) : null}
                {props.onReference && details(row.id)?.version ? (
                  <PillButton
                    variant="ghost"
                    onClick={() =>
                      props.onReference?.({
                        documentId: row.id,
                        version: details(row.id)!.version!,
                        location: snippet.location,
                      })
                    }
                  >
                    引用此片段
                  </PillButton>
                ) : null}
              </p>
            ))}
          </span>
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
        <PanelHeader title="资料库" />

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

        {props.myFiles !== undefined ||
        props.onAddMyFile !== undefined ||
        props.actions !== undefined ? (
          <>
            <TreeSectionHeader
              label="我的资料"
              onAdd={props.actions ? () => setConfirmImport(true) : props.onAddMyFile}
              addLabel="添加资料"
            />
            {(props.myFiles ?? []).map((node) => (
              <TreeItem key={node.id} label={node.label} icon={node.icon} depth={node.depth ?? 0} />
            ))}
          </>
        ) : null}

        {props.teamSpaces !== undefined || props.onSubscribeTeam !== undefined ? (
          <>
            <TreeSectionHeader
              label="团队空间"
              onAdd={props.onSubscribeTeam}
              addLabel="订阅团队空间"
            />
            {(props.teamSpaces ?? []).map((node) => (
              <TreeItem key={node.id} label={node.label} icon={node.icon} depth={node.depth ?? 0} />
            ))}
            {(props.teamSpaces ?? []).length === 0 ? (
              <p className="ew-library-hint">团队空间是只读的：订阅之后可以查看，但不能改。</p>
            ) : null}
          </>
        ) : null}

        {usage && props.onCleanup ? (
          <QuotaFooter
            usedLabel={usage.label}
            percent={usage.percent}
            onCleanup={props.onCleanup}
          />
        ) : usage ? (
          <p className="ew-library-hint">{usage.label}</p>
        ) : null}
      </nav>

      <main className="ew-library-main" aria-label="资料库">
        {props.actions ? (
          <PillButton variant="ghost" onClick={() => setConfirmCleanup(true)}>
            清理正文缓存
          </PillButton>
        ) : null}
        {confirmUpdate ? (
          <Dialog
            title="更新资料副本"
            confirmLabel="选择替换文件"
            onCancel={() => setConfirmUpdate(null)}
            onConfirm={() => {
              const id = confirmUpdate;
              setConfirmUpdate(null);
              void act(() => props.actions!.updateLibraryImport({ documentId: id }));
            }}
          >
            <p>
              选择一个同类型文件替换本机资料副本，并重新建立索引。外部原文件保留，原有识别结果不再用于搜索。
            </p>
          </Dialog>
        ) : null}
        {confirmCleanup ? (
          <Dialog
            title="清理正文缓存"
            confirmLabel="清理"
            onCancel={() => setConfirmCleanup(false)}
            onConfirm={() => {
              setConfirmCleanup(false);
              void act(() => props.actions!.clearLibraryBodyCache());
            }}
          >
            <p>
              删除可重建的正文解析缓存，保留原文件、资料副本、索引与登记选择。OCR
              页缓存暂不在本次清理范围。
            </p>
          </Dialog>
        ) : null}
        {ocrRuntime ? (
          <p className="ew-library-hint">
            {ocrRuntime.message}
            {ocrRuntime.canInstall ? (
              <PillButton variant="ghost" onClick={() => setInstallOcr(true)}>
                安装 OCR 组件
              </PillButton>
            ) : null}
          </p>
        ) : null}
        {preview ? (
          <Dialog
            title={preview.name}
            confirmLabel="关闭"
            onConfirm={() => setPreview(null)}
            onCancel={() => setPreview(null)}
          >
            <FilePreview preview={preview} />
          </Dialog>
        ) : null}
        {installOcr ? (
          <Dialog
            title="安装本地 OCR 组件"
            confirmLabel="安装"
            onCancel={() => setInstallOcr(false)}
            onConfirm={() => {
              setInstallOcr(false);
              setMessage('正在安装并校验 OCR 组件…');
              void props
                .actions!.installOcrRuntime()
                .then((next) => {
                  setOcrRuntime(next);
                  setMessage(next.message);
                })
                .catch((error) =>
                  setMessage(error instanceof Error ? error.message : '安装失败。'),
                );
            }}
          >
            <p>
              从已配置的离线包安装，大小约 {Math.ceil((ocrRuntime?.bytes ?? 0) / 1024 / 1024)}{' '}
              MiB。不上传文档；安装完成后可继续处理。
            </p>
          </Dialog>
        ) : null}
        {props.actions && !data?.bodySearchEnabled ? (
          <div className="ew-library-hint">
            正文检索尚未开启。
            <PillButton variant="ghost" onClick={() => setConfirmEnable(true)}>
              开启本机正文检索
            </PillButton>
          </div>
        ) : null}
        {props.actions ? (
          <PillButton variant="ghost" onClick={() => setConfirmImport(true)}>
            添加资料
          </PillButton>
        ) : null}
        <div className="ew-library-toolbar">
          <h1 className="ew-library-title">{NAV_TITLE[nav]}</h1>
          {nav === 'search' ? (
            <SearchInput
              ariaLabel="搜索资料"
              placeholder={data?.bodySearchEnabled ? '搜索文件名和正文' : '搜索文件名'}
              value={query}
              onChange={setQuery}
            />
          ) : null}
          {nav === 'recent' ? (
            <SegmentedControl
              variant="light"
              ariaLabel="最近视图"
              value={tab}
              items={RECENT_TABS.filter(
                (item) => item.id !== 'shared-by-me' || props.shares !== undefined,
              ).map((item) => ({ id: item.id, label: item.label }))}
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

        {nav === 'search' && props.actions && data?.bodySearchEnabled ? (
          <div className="ew-library-filter">
            <InlineSelect
              ariaLabel="项目筛选"
              placeholder="全部项目"
              value={project}
              options={[
                { id: 'all', label: '全部项目' },
                ...(data.projects ?? []).map((p) => ({ id: p.id, label: p.name })),
              ]}
              onChange={(id) => {
                setProject(id);
                setThread('all');
              }}
            />
            <InlineSelect
              ariaLabel="任务筛选"
              placeholder="全部任务"
              value={thread}
              options={[
                { id: 'all', label: '全部任务' },
                ...Array.from(
                  new Set(
                    (data.rows ?? [])
                      .filter((r) => project === 'all' || r.projectId === project)
                      .flatMap((r) => (r.threadId ? [r.threadId] : [])),
                  ),
                ).map((id) => ({ id, label: `任务 ${id.slice(0, 8)}` })),
              ]}
              onChange={setThread}
            />
            <InlineSelect
              ariaLabel="来源筛选"
              placeholder="全部来源"
              value={source}
              options={[
                { id: 'all', label: '全部来源' },
                { id: 'artifact', label: '本地产物' },
                { id: 'mine', label: '我的资料' },
              ]}
              onChange={(id) => setSource(id as typeof source)}
            />
          </div>
        ) : null}
        {busy ? (
          <p role="status">
            正在搜索…{' '}
            <PillButton
              variant="ghost"
              onClick={() => {
                ++generation.current;
                setBusy(false);
                void props.actions?.cancelLibrarySearch();
              }}
            >
              取消
            </PillButton>
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {nav === 'recent' && tab === 'shared-by-me' ? (
          <SharesTable
            shares={props.shares ?? []}
            onRevoke={props.onRevokeShare}
            onCopy={props.onCopyShareLink}
          />
        ) : (
          <DataTable
            ariaLabel="资料列表"
            columns={columns}
            rows={rows}
            onRowClick={open}
            {...(props.onDelete || props.onShare || props.actions
              ? {
                  rowActions: (row: LibraryRow) => (
                    <>
                      {props.onShare && row.source === 'artifact' && !details(row.id)?.version ? (
                        // 「分享」先过授权模态（Q10 规则 1：逐次授权，不记住选择）
                        <PillButton variant="ghost" onClick={() => props.onShare?.(row)}>
                          分享
                        </PillButton>
                      ) : null}
                      {props.actions ? (
                        <>
                          {props.onReference && details(row.id)?.version ? (
                            <PillButton
                              variant="ghost"
                              onClick={() =>
                                props.onReference?.({
                                  documentId: row.id,
                                  version: details(row.id)!.version!,
                                })
                              }
                            >
                              引用到任务
                            </PillButton>
                          ) : null}
                          {['queued', 'inspecting', 'extracting', 'ocr'].includes(
                            details(row.id)?.state ?? '',
                          ) ? (
                            <PillButton
                              variant="ghost"
                              onClick={() =>
                                void act(() =>
                                  props.actions!.controlLibraryDocument({
                                    documentId: row.id,
                                    action: 'stop',
                                  }),
                                )
                              }
                            >
                              停止
                            </PillButton>
                          ) : (
                            <PillButton
                              variant="ghost"
                              onClick={() =>
                                void act(() =>
                                  props.actions!.controlLibraryDocument({
                                    documentId: row.id,
                                    action: 'continue',
                                  }),
                                )
                              }
                            >
                              继续/重建索引
                            </PillButton>
                          )}
                          {row.source === 'mine' ? (
                            <PillButton variant="ghost" onClick={() => setConfirmUpdate(row.id)}>
                              更新副本
                            </PillButton>
                          ) : null}
                          {['png', 'jpg', 'jpeg', 'webp', 'pdf'].includes(row.extension ?? '') ? (
                            <PillButton variant="ghost" onClick={() => setConfirmOcr(row.id)}>
                              识别文字
                            </PillButton>
                          ) : null}
                          <PillButton
                            variant="ghost"
                            onClick={() => {
                              setPendingDelete(row);
                              setAlsoDeleteFile(false);
                            }}
                          >
                            移除
                          </PillButton>
                        </>
                      ) : null}
                      {props.onDelete ? (
                        <IconButton
                          label={`删除 ${row.name}`}
                          icon="🗑"
                          onClick={() => {
                            setPendingDelete(row);
                            setAlsoDeleteFile(false);
                          }}
                        />
                      ) : null}
                    </>
                  ),
                }
              : {})}
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

        {searchRows ? (
          <div>
            <PillButton
              variant="ghost"
              disabled={offset === 0 || busy}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </PillButton>
            <span>第 {Math.floor(offset / 20) + 1} 页</span>
            <PillButton
              variant="ghost"
              disabled={!hasMore || busy}
              onClick={() => setOffset(offset + 20)}
            >
              下一页
            </PillButton>
          </div>
        ) : null}
        {confirmEnable ? (
          <Dialog
            title="开启本机正文检索"
            onCancel={() => setConfirmEnable(false)}
            confirmLabel="开启"
            onConfirm={() => {
              setConfirmEnable(false);
              void act(() => props.actions!.enableLibrarySearch());
            }}
          >
            <p>
              读取当前可见本地产物和明确加入的资料，在本机建立正文索引。不会扫描历史附件或其他目录。图片需另选识别文字。停止和移除选择会保留。
            </p>
          </Dialog>
        ) : null}
        {confirmImport ? (
          <Dialog
            title="添加资料"
            onCancel={() => setConfirmImport(false)}
            confirmLabel="选择文件并建立副本"
            onConfirm={() => {
              setConfirmImport(false);
              void act(() => props.actions!.importLibraryFiles());
            }}
          >
            <p>
              一次最多 20
              个文件。复制到本机资料目录后登记并解析正文，外部原文件保留。移除“我的资料”会删除这里的副本。
            </p>
          </Dialog>
        ) : null}
        {confirmOcr ? (
          <Dialog
            title="在本机识别文字"
            onCancel={() => setConfirmOcr(null)}
            confirmLabel="识别文字"
            onConfirm={() => {
              const id = confirmOcr;
              setConfirmOcr(null);
              void act(() =>
                props.actions!.controlLibraryDocument({
                  documentId: id,
                  action: 'ocr',
                  ...(ocrRotation !== 'auto'
                    ? { rotation: Number(ocrRotation) as 0 | 90 | 180 | 270 }
                    : {}),
                }),
              );
            }}
          >
            <p>
              仅在本机处理简体中文和英文印刷体，原文件保留。OCR
              结果可能有误，请核对金额和编号；每批最多 100 页，可停止。
            </p>
            <InlineSelect
              ariaLabel="识别方向"
              placeholder="自动判断"
              value={ocrRotation}
              options={[
                { id: 'auto', label: '自动判断' },
                ...['0', '90', '180', '270'].map((id) => ({ id, label: `旋转 ${id}°` })),
              ]}
              onChange={setOcrRotation}
            />
          </Dialog>
        ) : null}
        {!props.tipDismissed && props.onDismissTip ? (
          <TipBanner
            title="资料库能帮你做什么"
            icon="◆"
            cards={[
              {
                title: '产物自动归集',
                body: '任务生成的文档、表格、幻灯片会自动进「本地产物」，跨任务也能找到。',
              },
              {
                title: '按文件名查找',
                body: '当前搜索只匹配文件名；正文索引接通后会再明确开放。',
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
          managed={!!props.actions}
          onToggleAlsoDelete={setAlsoDeleteFile}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            if (props.actions)
              void act(() =>
                props.actions!.controlLibraryDocument({
                  documentId: pendingDelete.id,
                  action: 'remove',
                }),
              );
            else props.onDelete?.(pendingDelete, alsoDeleteFile);
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
  managed,
  onToggleAlsoDelete,
  onCancel,
  onConfirm,
}: {
  readonly row: LibraryRow;
  readonly alsoDeleteFile: boolean;
  readonly managed: boolean;
  readonly onToggleAlsoDelete: (value: boolean) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const intent =
    row.source === 'artifact'
      ? describeRemoveArtifact(row.name, row.location)
      : describeDeleteMine(row.name);

  return (
    <Dialog
      title={intent.title}
      variant="danger"
      confirmLabel={intent.kind === 'delete-file' ? '删除文件' : '从资料库移除'}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p className="ew-delete-confirm-body">{intent.body}</p>
      {intent.offersFileDeletion && !managed ? (
        <label className="ew-delete-also">
          <input
            type="checkbox"
            checked={alsoDeleteFile}
            onChange={(event) => onToggleAlsoDelete(event.target.checked)}
          />
          同时删除磁盘上的文件
        </label>
      ) : null}
    </Dialog>
  );
}

/** 「我分享的」：链接 + 有效期倒计时 + 访问次数 + 撤销（06 §3.3 / 08 §7.2）。 */
const SHARE_TONE: Record<ShareRow['state'], 'neutral' | 'warning' | 'danger'> = {
  active: 'neutral',
  'expiring-soon': 'warning',
  expired: 'danger',
  revoked: 'danger',
};

function SharesTable({
  shares,
  onRevoke,
  onCopy,
}: {
  readonly shares: readonly ShareRow[];
  readonly onRevoke?: ((shareId: string) => void) | undefined;
  readonly onCopy?: ((url: string) => void) | undefined;
}) {
  const columns: Column<ShareRow>[] = [
    {
      id: 'name',
      header: '产物',
      render: (row) => (
        <span className="ew-share-cell">
          {row.name}
          {row.hasPassword ? <Badge variant="neutral">有密码</Badge> : null}
        </span>
      ),
      sortValue: (row) => row.name,
    },
    {
      id: 'expires',
      header: '有效期',
      render: (row) => <Badge variant={SHARE_TONE[row.state]}>{row.expiresLabel}</Badge>,
    },
    { id: 'access', header: '访问次数', render: (row) => row.accessCount, align: 'end' },
  ];
  return (
    <DataTable
      ariaLabel="我分享的"
      columns={columns}
      rows={shares}
      rowActions={(row) => (
        <>
          {onCopy && row.state !== 'revoked' && row.state !== 'expired' ? (
            <PillButton variant="ghost" onClick={() => onCopy(row.url)}>
              复制链接
            </PillButton>
          ) : null}
          {/*
            撤销即云端删除 + 链接失效（08 §7.2 规则 3）。
            已撤销 / 已过期的不再给这个按钮 —— 点它没有任何事情会发生，
            而一个点了没反应的按钮比没有按钮更让人怀疑状态是不是真的。
          */}
          {row.state === 'active' || row.state === 'expiring-soon' ? (
            <PillButton variant="ghost" onClick={() => onRevoke?.(row.id)}>
              撤销分享
            </PillButton>
          ) : null}
        </>
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

const STATE_LABEL: Record<string, string> = {
  queued: '待处理',
  inspecting: '检查中',
  extracting: '解析中',
  ocr: '识别中',
  searchable: '正文可搜',
  partial: '部分可搜',
  runtimeMissing: '组件缺失',
  ocrRequired: '待识别',
  stopped: '已停止',
  stale: '内容已变化',
  failed: '处理失败',
  paused: '容量上限已暂停',
};

export function highlightSegments(
  text: string,
  ranges: readonly { readonly start: number; readonly end: number }[],
): readonly { readonly text: string; readonly highlight: boolean }[] {
  const chars = Array.from(text),
    segments: { text: string; highlight: boolean }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const highlight = ranges.some((r) => i >= r.start && i < r.end),
      previous = segments[segments.length - 1];
    if (previous?.highlight === highlight) previous.text += chars[i];
    else segments.push({ text: chars[i]!, highlight });
  }
  return segments;
}
