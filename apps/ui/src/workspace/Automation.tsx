import { useState } from 'react'

import type {
  TriggerCreateParams,
  TriggerDryrunResult,
  TriggerSpec,
  TriggerView,
} from '@evowork/protocol'

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

type SpecKind = TriggerSpec['kind']

function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

function formatWhen(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return new Date(ms).toLocaleString()
}

function specLabel(spec: TriggerSpec): string {
  switch (spec.kind) {
    case 'once':
      return `一次性 · ${formatWhen(spec.at_ms)}`
    case 'interval':
      return spec.every_ms % 3_600_000 === 0
        ? `每 ${spec.every_ms / 3_600_000} 小时`
        : `每 ${Math.round(spec.every_ms / 60_000)} 分钟`
    case 'daily':
      return `每天 ${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`
    case 'weekly':
      return `每${WEEKDAYS[spec.weekday] ?? `周${spec.weekday}`} ${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`
    case 'monthly':
      return `每月 ${spec.day} 日 ${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`
    case 'webhook':
      return 'Webhook'
  }
}

export interface AutomationProps {
  connected: boolean
  readOnly: boolean
  busy: boolean
  triggers: TriggerView[]
  daemonBaseUrl: string
  dryruns: Record<string, TriggerDryrunResult>
  onCreate: (params: TriggerCreateParams) => void
  onDelete: (triggerId: string) => void
  onSetPaused: (trigger: TriggerView, paused: boolean) => void
  onDryrun: (triggerId: string) => void
}

export function Automation({
  connected,
  readOnly,
  busy,
  triggers,
  daemonBaseUrl,
  dryruns,
  onCreate,
  onDelete,
  onSetPaused,
  onDryrun,
}: AutomationProps) {
  const [name, setName] = useState('')
  const [intent, setIntent] = useState('')
  const [kind, setKind] = useState<SpecKind>('once')
  const [onceAt, setOnceAt] = useState('')
  const [intervalCount, setIntervalCount] = useState('60')
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours'>('minutes')
  const [timeOfDay, setTimeOfDay] = useState('08:00')
  const [weekday, setWeekday] = useState(0)
  const [monthDay, setMonthDay] = useState(1)
  const [formError, setFormError] = useState<string | null>(null)

  const disabled = !connected || readOnly || busy

  function parseClock(value: string): { hour: number; minute: number } | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value)
    if (!match) return null
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) return null
    return { hour, minute }
  }

  function buildSpec(): TriggerSpec | string {
    const tz = tzOffsetMinutes()
    switch (kind) {
      case 'once': {
        const atMs = new Date(onceAt).getTime()
        if (Number.isNaN(atMs)) return '请选择执行时间'
        return { kind: 'once', at_ms: atMs }
      }
      case 'interval': {
        const n = Number(intervalCount)
        if (!Number.isFinite(n) || n <= 0) return '间隔必须大于 0'
        return {
          kind: 'interval',
          every_ms: intervalUnit === 'hours' ? n * 3_600_000 : n * 60_000,
        }
      }
      case 'daily': {
        const clock = parseClock(timeOfDay)
        if (!clock) return '请填写每天的时间'
        return { kind: 'daily', ...clock, tz_offset_minutes: tz }
      }
      case 'weekly': {
        const clock = parseClock(timeOfDay)
        if (!clock) return '请填写每周的时间'
        return { kind: 'weekly', weekday, ...clock, tz_offset_minutes: tz }
      }
      case 'monthly': {
        const clock = parseClock(timeOfDay)
        if (!clock) return '请填写每月的时间'
        if (monthDay < 1 || monthDay > 31) return '日期必须是 1–31'
        return { kind: 'monthly', day: monthDay, ...clock, tz_offset_minutes: tz }
      }
      case 'webhook':
        return { kind: 'webhook' }
    }
  }

  return (
    <section className="automation" data-testid="automation">
      <h2>自动化</h2>
      <p className="muted">
        定时任务由本机 daemon 执行。关掉 UI 仍会跑；关机期间不会执行。
      </p>

      <form
        className="automation-form card"
        data-testid="automation-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (disabled) return
          if (name.trim().length === 0 || intent.trim().length === 0) {
            setFormError('名称和意图都不能空')
            return
          }
          const spec = buildSpec()
          if (typeof spec === 'string') {
            setFormError(spec)
            return
          }
          setFormError(null)
          onCreate({ name: name.trim(), intent: intent.trim(), spec, paused: false })
          setName('')
          setIntent('')
        }}
      >
        <h3>新建</h3>
        <label>
          名称
          <input
            data-testid="automation-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          意图
          <textarea
            data-testid="automation-intent"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={2}
            disabled={disabled}
            placeholder="到点之后 daemon 会用这段意图起一条 run"
          />
        </label>
        <label>
          触发方式
          <select
            data-testid="automation-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as SpecKind)}
            disabled={disabled}
          >
            <option value="once">一次性</option>
            <option value="interval">间隔</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="webhook">Webhook</option>
          </select>
        </label>
        {kind === 'once' ? (
          <label>
            执行时间
            <input
              data-testid="automation-once-at"
              type="datetime-local"
              value={onceAt}
              onChange={(e) => setOnceAt(e.target.value)}
              disabled={disabled}
            />
          </label>
        ) : null}
        {kind === 'interval' ? (
          <div className="automation-inline">
            <label>
              每隔
              <input
                data-testid="automation-interval-count"
                type="number"
                min={1}
                value={intervalCount}
                onChange={(e) => setIntervalCount(e.target.value)}
                disabled={disabled}
              />
            </label>
            <label>
              单位
              <select
                value={intervalUnit}
                onChange={(e) => setIntervalUnit(e.target.value as 'minutes' | 'hours')}
                disabled={disabled}
              >
                <option value="minutes">分钟</option>
                <option value="hours">小时</option>
              </select>
            </label>
          </div>
        ) : null}
        {kind === 'weekly' ? (
          <label>
            星期
            <select
              data-testid="automation-weekday"
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
              disabled={disabled}
            >
              {WEEKDAYS.map((label, i) => (
                <option key={label} value={i}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {kind === 'monthly' ? (
          <label>
            日期
            <input
              type="number"
              min={1}
              max={31}
              value={monthDay}
              onChange={(e) => setMonthDay(Number(e.target.value))}
              disabled={disabled}
            />
          </label>
        ) : null}
        {kind === 'daily' || kind === 'weekly' || kind === 'monthly' ? (
          <label>
            时间
            <input
              type="time"
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(e.target.value)}
              disabled={disabled}
            />
          </label>
        ) : null}
        {formError ? (
          <p className="banner error" role="alert">
            {formError}
          </p>
        ) : null}
        <button type="submit" data-testid="automation-submit" disabled={disabled}>
          创建
        </button>
      </form>

      {triggers.length === 0 ? (
        <p className="empty pane-empty" data-testid="automation-empty">
          还没有定时任务
        </p>
      ) : (
        <ul className="automation-list" data-testid="automation-list">
          {triggers.map((trigger) => {
            const hookUrl = trigger.hook_path
              ? `${daemonBaseUrl.replace(/\/$/, '')}${trigger.hook_path}`
              : null
            const report = dryruns[trigger.trigger_id]
            return (
              <li key={trigger.trigger_id} className="card trigger-card">
                <header>
                  <strong>{trigger.name}</strong>
                  {trigger.paused ? <span className="pill">已暂停</span> : null}
                  <span className="muted">{specLabel(trigger.spec)}</span>
                </header>
                <p className="intent">{trigger.intent}</p>
                <p className="muted">
                  下次 {formatWhen(trigger.next_fire_ms)}
                  {trigger.last_run_id ? ` · 最近 run ${trigger.last_run_id}` : ''}
                </p>
                {hookUrl ? (
                  <p className="muted">
                    POST <code data-testid="automation-hook-url">{hookUrl}</code>
                  </p>
                ) : null}
                {report ? (
                  <p className="muted" data-testid="automation-dryrun-result">
                    dry-run：{report.would_fire_now ? '现在会醒' : '现在不会醒'}
                    {report.next_fire_ms != null ? ` · 下次 ${formatWhen(report.next_fire_ms)}` : ''}
                  </p>
                ) : null}
                <div className="card-actions">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onSetPaused(trigger, !trigger.paused)}
                  >
                    {trigger.paused ? '恢复' : '暂停'}
                  </button>
                  <button
                    type="button"
                    disabled={!connected || busy}
                    data-testid="automation-dryrun"
                    onClick={() => onDryrun(trigger.trigger_id)}
                  >
                    预览
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={disabled}
                    data-testid="automation-delete"
                    onClick={() => onDelete(trigger.trigger_id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
