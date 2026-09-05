/**
 * 自动化：表单 + 执行历史（07 §3 / §5）。
 *
 * ## 三条"必须在配置时就说清"的
 *
 * 1. **关机不执行**（07 §4.2）。这句话要出现在**配置时**而不是只在事后解释，
 *    否则用户的心智模型从第一天就是错的（R9）。所以它是一条不可关闭的常驻提示。
 * 2. **绑定这台电脑**（07 §4.1 / Q15）。其他电脑能看见但不会重复执行。
 * 3. **并发与重试不做成选项**（Q8），但**要在界面上写明白**而不是隐藏 ——
 *    "上一次还没跑完会跳过""失败不重试、连败 3 次自动暂停"这两件事用户迟早会遇到。
 *
 * ## 「跳过」「漏跑」必须与「失败」分列
 *
 * 07 §5.1 的原话。混在一起统计的话，一个因为关机漏跑了 3 次的任务看起来像
 * "失败了 3 次"，而用户会去查任务本身的问题 —— 那里什么问题都没有。
 */
import { useMemo, useState } from 'react';

import {
  describeCron,
  OFFLINE_EXPECTATION_NOTICE,
  bindingNotice,
  parseNaturalSchedule,
  upcomingFireTimes,
  parseCron,
  CronParseError,
  type MisfirePolicy,
} from '@evowork/scheduler';

import { InlineSelect } from '../components/menu.js';
import { DataTable, PanelHeader, TextTabs, type Column } from '../components/panels.js';
import {
  Badge,
  Banner,
  EmptyState,
  PillButton,
  SearchInput,
  type BadgeVariant,
} from '../components/primitives.js';

/* ─────────────────────────── 表单 ─────────────────────────── */

export type ScheduleMode = 'common' | 'natural' | 'advanced';

export interface AutomationDraft {
  readonly name: string;
  readonly prompt: string;
  readonly workspaces: readonly string[];
  readonly schedule: string;
  readonly timezone: string;
  readonly misfirePolicy: MisfirePolicy;
  readonly catchupWindowHours: number;
  readonly wakeSystem: boolean;
  readonly budgetLimit: number;
  readonly testRun: boolean;
}

/** 07 §4.3 的人话。三项都附「只补最近 N 小时内错过的触发」。 */
export const MISFIRE_COPY: Readonly<
  Record<MisfirePolicy, { label: string; hint: string; warning?: string }>
> = Object.freeze({
  FIRE_ONCE_ON_WAKE: {
    label: '开机后补跑一次',
    hint: '无论错过几次，只补最近的一次',
  },
  FIRE_ALL: {
    label: '逐次补齐',
    hint: '错过 3 次就跑 3 次，适合"每次都要留痕"的任务',
    warning: '如果电脑关机较久，可能会连续执行多次并消耗较多额度。',
  },
  DROP: {
    label: '不补跑',
    hint: '错过就算了，适合时效性强的任务',
  },
});

/** Q8 定死、不做成选项、但**必须写出来**的两条（07 §3.2）。 */
export const FIXED_BEHAVIOR_NOTICE =
  '上一次还没跑完就到了下次时间，会跳过这一次；执行失败不会自动重试，连续失败 3 次会自动暂停并通知你。';

export interface AutomationFormProps {
  readonly draft: AutomationDraft;
  readonly onChange: (draft: AutomationDraft) => void;
  readonly deviceName: string;
  readonly workspaceOptions: readonly { readonly id: string; readonly label: string }[];
  readonly onSubmit?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly now?: number | undefined;
}

export function AutomationForm(props: AutomationFormProps) {
  const [mode, setMode] = useState<ScheduleMode>('common');
  const [natural, setNatural] = useState('');
  const { draft, onChange } = props;

  const preview = useMemo(
    () => previewSchedule(draft.schedule, draft.timezone, props.now ?? Date.now()),
    [draft.schedule, draft.timezone, props.now],
  );

  return (
    <form
      className="ew-automation-form"
      aria-label="新建自动化"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit?.();
      }}
    >
      <label className="ew-field">
        <span>名称</span>
        <input
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="从任务描述自动摘要"
        />
      </label>

      <label className="ew-field">
        <span>任务描述</span>
        <textarea
          value={draft.prompt}
          rows={4}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
          placeholder="用平常说话的方式描述要做什么，支持 @ 引用与 / 技能"
        />
      </label>

      <div className="ew-field">
        <span>工作空间</span>
        <InlineSelect
          ariaLabel="工作空间"
          placeholder="选择工作空间"
          value={draft.workspaces[0]}
          options={props.workspaceOptions}
          onChange={(id) => onChange({ ...draft, workspaces: [id] })}
        />
      </div>

      {/* ── 触发编辑器：三档递进（07 §3.3）── */}
      <fieldset className="ew-field ew-schedule">
        <legend>什么时候跑</legend>
        <TextTabs
          ariaLabel="触发方式"
          value={mode}
          onChange={(id) => setMode(id as ScheduleMode)}
          items={[
            { id: 'common', label: '常用' },
            { id: 'natural', label: '用说的' },
            { id: 'advanced', label: '高级' },
          ]}
        />

        {mode === 'common' ? (
          <div className="ew-schedule-presets">
            {COMMON_PRESETS.map((preset) => (
              <PillButton
                key={preset.cron}
                variant={draft.schedule === preset.cron ? 'accent' : 'default'}
                onClick={() => onChange({ ...draft, schedule: preset.cron })}
              >
                {preset.label}
              </PillButton>
            ))}
          </div>
        ) : null}

        {mode === 'natural' ? (
          <div className="ew-schedule-natural">
            <SearchInput
              ariaLabel="用自然语言描述时间"
              placeholder="例如：每个工作日下午六点"
              value={natural}
              onChange={(value) => {
                setNatural(value);
                const parsed = parseNaturalSchedule(value);
                // 解析不出来是**正常结果**（07 §3.3：本机规则，不调模型），不报错
                if (parsed) onChange({ ...draft, schedule: parsed.cron });
              }}
            />
            {natural && !parseNaturalSchedule(natural) ? (
              <p className="ew-schedule-fallback">
                这句话我没看懂。可以换个说法，或者用「常用」里的选项。
              </p>
            ) : null}
          </div>
        ) : null}

        {mode === 'advanced' ? (
          <label className="ew-field">
            <span>cron 表达式</span>
            <input
              value={draft.schedule}
              onChange={(event) => onChange({ ...draft, schedule: event.target.value })}
              placeholder="0 9 * * 1-5"
            />
          </label>
        ) : null}

        {/* **三档共有**的预览，且必须显示时区（07 §3.3） */}
        <SchedulePreview preview={preview} timezone={draft.timezone} />
      </fieldset>

      {/* 07 §4.2：这句话必须出现在**配置时**（R9），且不可关闭 */}
      <Banner tone="info">{OFFLINE_EXPECTATION_NOTICE}</Banner>

      <fieldset className="ew-field">
        <legend>错过了怎么办</legend>
        {(Object.keys(MISFIRE_COPY) as MisfirePolicy[]).map((policy) => (
          <label key={policy} className="ew-radio">
            <input
              type="radio"
              name="misfire"
              checked={draft.misfirePolicy === policy}
              onChange={() => onChange({ ...draft, misfirePolicy: policy })}
            />
            <span className="ew-radio-label">{MISFIRE_COPY[policy].label}</span>
            <span className="ew-radio-hint">{MISFIRE_COPY[policy].hint}</span>
          </label>
        ))}
        <p className="ew-field-hint">只补最近 {draft.catchupWindowHours} 小时内错过的触发。</p>
        {MISFIRE_COPY[draft.misfirePolicy].warning ? (
          <Banner tone="warning">{MISFIRE_COPY[draft.misfirePolicy].warning}</Banner>
        ) : null}
      </fieldset>

      <label className="ew-field">
        <span>本次预算上限（tokens）</span>
        <input
          type="number"
          min={1000}
          value={draft.budgetLimit}
          onChange={(event) => onChange({ ...draft, budgetLimit: Number(event.target.value) || 0 })}
        />
        {/* 07 §8-3：定时任务**不得不设**预算 —— 一个失控循环会在夜里烧完配额 */}
        <span className="ew-field-hint">
          定时任务必须设预算：没人在旁边看着的时候，一个循环会把额度烧完。
        </span>
      </label>

      <label className="ew-checkbox">
        <input
          type="checkbox"
          checked={draft.wakeSystem}
          onChange={(event) => onChange({ ...draft, wakeSystem: event.target.checked })}
        />
        允许唤醒这台电脑
      </label>
      {draft.wakeSystem ? (
        // 不承诺"一定能唤醒"——那是操作系统决定的（07 §4.4 / D5）
        <p className="ew-field-hint">
          开启后会请求系统在触发时唤醒电脑。
          <strong>合盖、断电或系统禁用唤醒时仍然不会执行。</strong>
        </p>
      ) : null}

      {/* Q8 定死的两条：不做成选项，但写明白（07 §3.2） */}
      <p className="ew-field-hint ew-fixed-behavior">{FIXED_BEHAVIOR_NOTICE}</p>

      {/* Q15：绑定这台电脑 */}
      <p className="ew-field-hint">{bindingNotice(props.deviceName)}</p>

      <label className="ew-checkbox">
        <input
          type="checkbox"
          checked={draft.testRun}
          onChange={(event) => onChange({ ...draft, testRun: event.target.checked })}
        />
        保存并立即试跑一次
      </label>

      <div className="ew-form-actions">
        <PillButton onClick={props.onCancel}>取消</PillButton>
        <PillButton variant="accent" onClick={props.onSubmit}>
          保存
        </PillButton>
      </div>
    </form>
  );
}

const COMMON_PRESETS = [
  { label: '每天 9:00', cron: '0 9 * * *' },
  { label: '每个工作日 9:00', cron: '0 9 * * 1-5' },
  { label: '每周一 9:00', cron: '0 9 * * 1' },
  { label: '每月 1 号 9:00', cron: '0 9 1 * *' },
] as const;

export type SchedulePreviewResult =
  | { readonly ok: true; readonly description: string; readonly next: readonly number[] }
  | { readonly ok: false; readonly reason: string };

/** 「未来 5 次触发时间」（07 §3.3：三档共有，防配错最有效的手段）。 */
export function previewSchedule(
  schedule: string,
  timezone: string,
  now: number,
): SchedulePreviewResult {
  try {
    const fields = parseCron(schedule);
    const next = upcomingFireTimes(fields, now, timezone, 5);
    if (next.length === 0) {
      return { ok: false, reason: '这个表达式永远不会触发（比如 2 月 30 日）。' };
    }
    return { ok: true, description: describeCron(schedule), next };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof CronParseError ? err.message : '这个表达式看不懂。',
    };
  }
}

function SchedulePreview({
  preview,
  timezone,
}: {
  readonly preview: SchedulePreviewResult;
  readonly timezone: string;
}) {
  if (!preview.ok) {
    return <Banner tone="danger">{preview.reason}</Banner>;
  }
  return (
    <div className="ew-schedule-preview">
      <p className="ew-schedule-description">{preview.description}</p>
      <p className="ew-field-hint">接下来 5 次（{timezone}）：</p>
      <ul className="ew-schedule-times">
        {preview.next.map((at) => (
          <li key={at}>{formatInZone(at, timezone)}</li>
        ))}
      </ul>
    </div>
  );
}

/** 带时区的显示。不显示时区的预览起不到防配错的作用。 */
export function formatInZone(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at));
}

/* ─────────────────────────── 执行历史 ─────────────────────────── */

export interface RunRow {
  readonly id: string;
  readonly fireTime: number;
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'MISSED';
  readonly skipReason?: string | undefined;
  readonly failureClass?: string | undefined;
  readonly trigger: string;
  readonly originalFireTime?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly tokenUsage?: number | undefined;
  readonly artifactCount?: number | undefined;
}

/** 07 §5.2 的映射表。**跳过与漏跑不是失败**，Badge 与文案都要区分开。 */
export function describeRunStatus(row: RunRow): { badge: BadgeVariant; text: string } {
  if (row.status === 'SUCCEEDED') return { badge: 'success', text: '成功' };
  if (row.status === 'RUNNING') return { badge: 'info', text: '执行中' };
  if (row.status === 'FAILED') {
    return {
      badge: 'danger',
      text: `失败 · ${FAILURE_TEXT[row.failureClass ?? ''] ?? '未知原因'}`,
    };
  }
  if (row.status === 'MISSED') {
    return { badge: 'neutral', text: '漏跑 · 当时电脑关机或睡眠' };
  }
  const skip = row.skipReason ?? '';
  if (skip === 'CONCURRENCY') return { badge: 'warning', text: '跳过 · 上一次还在执行中' };
  if (skip === 'QUOTA') return { badge: 'warning', text: '跳过 · 额度不足' };
  if (skip === 'OUT_OF_WINDOW') return { badge: 'neutral', text: '跳过 · 不在生效期内' };
  return { badge: 'neutral', text: '跳过' };
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  MODEL: '模型调用失败',
  SCRIPT: '执行过程中出错',
  APPROVAL_TIMEOUT: '等待确认超时',
  ENVIRONMENT: '运行环境的问题',
  QUOTA: '超出预算上限',
};

export interface RunStats {
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly missed: number;
}

/** 近 N 次的统计（07 §5.1）。**四项分列**，不把跳过与漏跑并进失败。 */
export function summarizeRuns(rows: readonly RunRow[], limit = 30): RunStats {
  const recent = rows.slice(0, limit);
  return {
    succeeded: recent.filter((r) => r.status === 'SUCCEEDED').length,
    failed: recent.filter((r) => r.status === 'FAILED').length,
    skipped: recent.filter((r) => r.status === 'SKIPPED').length,
    missed: recent.filter((r) => r.status === 'MISSED').length,
  };
}

export function AutomationHistory({
  name,
  rows,
  timezone,
  paused,
  onResume,
  onOpenTask,
}: {
  readonly name: string;
  readonly rows: readonly RunRow[];
  readonly timezone: string;
  readonly paused?: boolean | undefined;
  readonly onResume?: (() => void) | undefined;
  readonly onOpenTask?: ((runId: string) => void) | undefined;
}) {
  const stats = summarizeRuns(rows);

  const columns: Column<RunRow>[] = [
    {
      id: 'fireTime',
      header: '触发时间',
      render: (row) => (
        <span>
          {formatInZone(row.fireTime, timezone)}
          {row.trigger === 'MANUAL_TEST' ? <Badge variant="neutral">试跑</Badge> : null}
          {row.trigger === 'MANUAL' ? <Badge variant="neutral">手动</Badge> : null}
          {/* 补跑要标注原定时刻，否则用户看不出这条是补的（07 §8-1） */}
          {row.trigger === 'CATCHUP' && row.originalFireTime !== undefined ? (
            <Badge variant="info">
              补跑（原定 {formatInZone(row.originalFireTime, timezone)}）
            </Badge>
          ) : null}
        </span>
      ),
      sortValue: (row) => row.fireTime,
    },
    {
      id: 'status',
      header: '状态',
      render: (row) => {
        const view = describeRunStatus(row);
        return <Badge variant={view.badge}>{view.text}</Badge>;
      },
    },
    {
      id: 'result',
      header: '结果',
      render: (row) =>
        row.status === 'SUCCEEDED' ? (
          <PillButton variant="ghost" onClick={() => onOpenTask?.(row.id)}>
            {row.artifactCount ? `${row.artifactCount} 个产物 · 查看任务` : '查看任务'}
          </PillButton>
        ) : (
          <span className="ew-run-result-muted">—</span>
        ),
    },
    {
      id: 'duration',
      header: '耗时',
      render: (row) =>
        row.durationMs === undefined ? '—' : `${Math.round(row.durationMs / 1000)}s`,
      align: 'end',
    },
    {
      id: 'usage',
      header: '用量',
      // 成本标「估算」（10 §5.2 的诚实要求）
      render: (row) =>
        row.tokenUsage === undefined ? '—' : `${row.tokenUsage.toLocaleString('zh-CN')} tokens`,
      align: 'end',
    },
  ];

  return (
    <section className="ew-automation-history">
      <PanelHeader title={name} />

      {paused ? (
        <Banner
          tone="warning"
          action={
            <PillButton variant="accent" onClick={onResume}>
              恢复
            </PillButton>
          }
        >
          连续失败 3 次后已自动暂停。看看下面几次的失败原因，改好之后点「恢复」。
        </Banner>
      ) : null}

      {/* 四项分列（07 §5.1）：混在一起会让"关机漏跑"看起来像"任务有问题" */}
      <p className="ew-run-stats">
        近 30 次：成功 {stats.succeeded} · 失败 {stats.failed} · 跳过 {stats.skipped} · 漏跑{' '}
        {stats.missed}
      </p>

      <DataTable
        ariaLabel="执行历史"
        columns={columns}
        rows={rows}
        emptyState={
          <EmptyState
            title="还没有执行过"
            hint="到了设定的时间它会自动运行；也可以在上面点「立即运行一次」先试试。"
          />
        }
      />
    </section>
  );
}
