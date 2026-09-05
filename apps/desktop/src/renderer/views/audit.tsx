/**
 * 用量与审计（10 §6，Q12 落地的两项之一）。
 *
 * ## 「用户可见」是这一页存在的理由
 *
 * 10 §6 的原话：Q1=A 下**没有企业后台能替用户看**，审计如果只写不读就是死数据。
 * 所以这一页不是合规摆设，它要能被真的用起来：按时间/任务/工具筛选、能导出。
 *
 * ## 这一页永远不会显示正文
 *
 * `AuditRecord` 里就没有能装正文的字段（见 `@evowork/policy` 的 audit.ts）——
 * 路径以 `pathKind` + `pathDigest` 呈现。所以"审计页会不会泄漏内容"这个问题
 * 在类型层面就已经回答了，这一页只需要把它**呈现得让人看懂**：
 * 一串哈希对用户没用，所以显示的是"受保护位置（凭据）"这样的分类 + 短哈希。
 */
import { useMemo, useState } from 'react';

import {
  RETENTION_DAYS,
  RETENTION_WARNING_DAYS,
  verifyChain,
  type AuditAction,
  type AuditRecord,
} from '@evowork/policy';

import { InlineSelect } from '../components/menu.js';
import { DataTable, PanelHeader, type Column } from '../components/panels.js';
import {
  Badge,
  Banner,
  EmptyState,
  PillButton,
  SearchInput,
  type BadgeVariant,
} from '../components/primitives.js';

export type AuditRange = '24h' | '7d' | '30d' | 'all';

const RANGE_MS: Readonly<Record<AuditRange, number>> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: Number.POSITIVE_INFINITY,
};

const RANGE_LABEL: Readonly<Record<AuditRange, string>> = {
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  all: '全部',
};

/** 动作 → 人话。审计表里存的是枚举，用户看的是这一列。 */
export const ACTION_LABEL: Readonly<Record<AuditAction, string>> = Object.freeze({
  'tool.pre': '执行工具',
  'tool.post': '工具完成',
  'permission.request': '请求权限',
  'permission.decided': '权限决定',
  'path.blocked': '已阻止访问',
  'guardian.verdict': '安全审查',
  'budget.exceeded': '超出预算',
  'concurrency.rejected': '超出并发',
  'session.end': '会话结束',
});

const ACTION_BADGE: Readonly<Partial<Record<AuditAction, BadgeVariant>>> = {
  'path.blocked': 'danger',
  'budget.exceeded': 'warning',
  'concurrency.rejected': 'warning',
  'permission.decided': 'info',
};

/** 路径分类 → 人话。**一串哈希对用户没用**，有用的是"它属于哪一类受保护位置"。 */
export const PATH_KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'system-dirs': '系统目录',
  credentials: '密钥与凭据',
  'evowork-self': 'EvoWork 自身配置',
  'personal-dir': '个人目录',
  'outside-workspace': '工作空间之外',
  workspace: '工作空间内',
});

export interface AuditRow extends AuditRecord {
  readonly id: string;
}

export interface AuditPageProps {
  readonly records: readonly AuditRow[];
  readonly now?: number | undefined;
  /** 每日链式哈希（10 §6 的防篡改）。给了就做一次校验并显示结果 */
  readonly chain?:
    readonly { readonly chainHash: string; readonly records: readonly AuditRecord[] }[] | undefined;
  readonly onExport?: ((format: 'csv' | 'jsonl') => void) | undefined;
  readonly retentionDays?: number | undefined;
  /** 最早一条记录的时间，用来算"还有几天到期" */
  readonly oldestAt?: number | undefined;
}

export function AuditPage(props: AuditPageProps) {
  const now = props.now ?? Date.now();
  const [range, setRange] = useState<AuditRange>('7d');
  const [action, setAction] = useState<AuditAction | 'all'>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const since = now - RANGE_MS[range];
    return props.records.filter((record) => {
      if (record.occurredAt < since) return false;
      if (action !== 'all' && record.action !== action) return false;
      if (query) {
        const haystack = [record.toolName, record.actionSummary, record.threadId]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query.toLowerCase())) return false;
      }
      return true;
    });
  }, [props.records, range, action, query, now]);

  const integrity = useMemo(
    () => (props.chain ? verifyChain(props.chain) : undefined),
    [props.chain],
  );

  const retention = props.retentionDays ?? RETENTION_DAYS;
  const expiringInDays =
    props.oldestAt === undefined
      ? undefined
      : Math.ceil(retention - (now - props.oldestAt) / (24 * 60 * 60 * 1000));

  const columns: Column<AuditRow>[] = [
    {
      id: 'time',
      header: '时间',
      render: (row) => new Date(row.occurredAt).toLocaleString('zh-CN', { hour12: false }),
      sortValue: (row) => row.occurredAt,
    },
    {
      id: 'action',
      header: '动作',
      render: (row) => {
        const badge = ACTION_BADGE[row.action];
        const label = ACTION_LABEL[row.action];
        return badge ? <Badge variant={badge}>{label}</Badge> : label;
      },
    },
    { id: 'tool', header: '工具', render: (row) => row.toolName ?? '—' },
    {
      id: 'target',
      header: '对象',
      // 分类 + 短哈希：既不泄漏路径，又能让同一个路径在多条记录间对得上
      render: (row) =>
        row.pathKind === undefined ? (
          (row.networkTarget ?? '—')
        ) : (
          <span className="ew-audit-target">
            {PATH_KIND_LABEL[row.pathKind] ?? row.pathKind}
            {row.pathDigest ? (
              <code className="ew-audit-digest">{row.pathDigest.slice(0, 8)}</code>
            ) : null}
          </span>
        ),
    },
    { id: 'summary', header: '摘要', render: (row) => row.actionSummary ?? '—' },
    {
      id: 'decided',
      header: '决定',
      render: (row) =>
        row.approvalResult === undefined
          ? '—'
          : `${APPROVAL_LABEL[row.approvalResult] ?? row.approvalResult}（${DECIDER_LABEL[row.decidedBy ?? ''] ?? row.decidedBy ?? '—'}）`,
    },
    {
      id: 'usage',
      header: '用量',
      render: (row) =>
        row.tokenUsage === undefined ? '—' : row.tokenUsage.toLocaleString('zh-CN'),
      align: 'end',
    },
  ];

  return (
    <section className="ew-audit">
      <PanelHeader
        title="用量与审计"
        actions={
          <>
            <PillButton variant="ghost" onClick={() => props.onExport?.('csv')}>
              导出 CSV
            </PillButton>
            <PillButton variant="ghost" onClick={() => props.onExport?.('jsonl')}>
              导出 JSONL
            </PillButton>
          </>
        }
      />

      {/* 这一页最该让用户知道的一件事 */}
      <Banner tone="info">
        审计只记动作、路径分类与结果，<strong>不记 prompt 正文、文件内容和命令输出</strong>。
        记录保留 {retention} 天，只存在这台电脑上。
      </Banner>

      {integrity && !integrity.ok ? (
        <Banner tone="danger">
          审计链在第 {(integrity.firstBrokenIndex ?? 0) + 1} 天对不上 —— 有记录被删改过。
          导出的文件会带上这个校验结果。
        </Banner>
      ) : null}

      {expiringInDays !== undefined && expiringInDays <= RETENTION_WARNING_DAYS ? (
        // 到期前提示再清理（10 §6），而不是到点静默删掉
        <Banner tone="warning">
          最早的记录还有 {Math.max(0, expiringInDays)} 天到期并被自动清理。需要留档就先导出。
        </Banner>
      ) : null}

      <div className="ew-audit-filters">
        <InlineSelect
          ariaLabel="时间范围"
          placeholder={RANGE_LABEL['7d']}
          value={range}
          options={(Object.keys(RANGE_LABEL) as AuditRange[]).map((id) => ({
            id,
            label: RANGE_LABEL[id],
          }))}
          onChange={(id) => setRange(id as AuditRange)}
        />
        <InlineSelect
          ariaLabel="动作类型"
          placeholder="全部动作"
          value={action === 'all' ? undefined : action}
          options={[
            { id: 'all', label: '全部动作' },
            ...(Object.keys(ACTION_LABEL) as AuditAction[]).map((id) => ({
              id,
              label: ACTION_LABEL[id],
            })),
          ]}
          onChange={(id) => setAction(id === 'all' ? 'all' : (id as AuditAction))}
        />
        <SearchInput
          ariaLabel="搜索审计记录"
          placeholder="按工具名或任务搜索"
          value={query}
          onChange={setQuery}
        />
      </div>

      <DataTable
        ariaLabel="审计记录"
        columns={columns}
        rows={rows}
        emptyState={
          <EmptyState
            title={props.records.length === 0 ? '还没有审计记录' : '这段时间没有记录'}
            hint={
              props.records.length === 0
                ? '执行工具、请求权限、被拦截的访问都会记在这里。'
                : '换个时间范围或动作类型看看。'
            }
          />
        }
      />
    </section>
  );
}

const APPROVAL_LABEL: Readonly<Record<string, string>> = {
  accept: '允许',
  'accept-for-session': '本次任务内允许',
  decline: '拒绝',
  cancel: '取消',
  timeout: '超时自动取消',
};

const DECIDER_LABEL: Readonly<Record<string, string>> = {
  user: '你',
  policy: '策略',
  timeout: '超时',
  guardian: '安全审查',
};

/**
 * 导出（10 §6：可导出 CSV/JSONL）。
 *
 * 导出的内容与页面上看到的**完全一样** —— 不多给字段。
 * "导出时顺便带上原始路径"是很自然的想法，而它会让一份本来不含正文的记录
 * 在离开这台电脑时突然含了。
 */
export function toCsv(rows: readonly AuditRow[]): string {
  const header = ['时间', '动作', '工具', '对象类型', '对象摘要', '结果', '决定人', '用量'];
  const lines = rows.map((row) =>
    [
      new Date(row.occurredAt).toISOString(),
      ACTION_LABEL[row.action],
      row.toolName ?? '',
      row.pathKind ?? '',
      row.pathDigest ?? '',
      row.approvalResult ?? '',
      row.decidedBy ?? '',
      row.tokenUsage ?? '',
    ]
      .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
      .join(','),
  );
  // BOM 用转义写：字面量的 U+FEFF 在编辑器里不可见，读代码的人只会看到一个多余的空格
  return `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

export function toJsonl(rows: readonly AuditRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}
