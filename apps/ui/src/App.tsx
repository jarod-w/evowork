import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ApprovalDecideParams,
  ClarificationAnswerParams,
  Event,
  RunCreateParams,
  RunCreateResult,
  ServerStreamFrame,
} from '@evowork/protocol'

import { createDaemonClient } from './daemon/client'
import type { DaemonClient, DaemonClientStatus } from './daemon/client'
import { getPlatform } from './platform'
import type { PlatformInfo } from './platform'
import { applyEvent, emptyWorkspace, workspaceCostMicros } from './projection/fold'
import type { RunView, WorkspaceView } from './projection/fold'
import { formatMicros, runStatusLabel } from './projection/format'
import { Artifacts } from './workspace/Artifacts'
import { Composer } from './workspace/Composer'
import { CostPane } from './workspace/CostPane'
import { Inbox } from './workspace/Inbox'
import { StatusBar } from './workspace/StatusBar'
import { Timeline } from './workspace/Timeline'
import { useBlobTexts } from './workspace/useBlobTexts'
import { ApprovalCard } from './workspace/ApprovalCard'

const DEFAULT_BASE = 'http://localhost:4477'

function defaultClient(): DaemonClient {
  return createDaemonClient({
    baseUrl: import.meta.env.VITE_DAEMON_URL ?? DEFAULT_BASE,
    token: import.meta.env.VITE_DAEMON_TOKEN ?? '',
  })
}

interface AppProps {
  /** Tests inject a stub. Production leaves this unset. */
  client?: DaemonClient
}

export default function App({ client }: AppProps) {
  const daemonClient = useMemo(() => client ?? defaultClient(), [client])
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [daemonStatus, setDaemonStatus] = useState<DaemonClientStatus>(daemonClient.getStatus())
  const [daemonError, setDaemonError] = useState<string | null>(null)
  const [view, setView] = useState<WorkspaceView>(emptyWorkspace)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getPlatform().then((platform) => {
      if (!cancelled) setPlatformInfo(platform.info)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let sub: { unsubscribe(): void } | null = null
    daemonClient
      .hello()
      .then(() => {
        if (cancelled) return
        setDaemonStatus(daemonClient.getStatus())
        setDaemonError(null)
        sub = daemonClient.subscribeAll((frame: ServerStreamFrame) => {
          if (frame.op !== 'event') return
          const event: Event = frame.event
          setView((prev) => applyEvent(prev, event))
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDaemonStatus(daemonClient.getStatus())
        setDaemonError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      sub?.unsubscribe()
    }
  }, [daemonClient])

  const selected: RunView | undefined = view.runs.find((run) => run.runId === selectedRunId) ?? view.runs[0]
  const selectedId = selected?.runId ?? null

  const blobRefs = useMemo(() => {
    const refs = []
    for (const item of view.inbox) {
      if (item.kind === 'clarification') refs.push(item.clarification.promptRef)
    }
    if (selected) {
      if (selected.intentRef) refs.push(selected.intentRef)
      for (const artifact of selected.artifacts) refs.push(artifact.blob)
    }
    return refs
  }, [view.inbox, selected])

  const blobTexts = useBlobTexts(daemonClient, daemonStatus.connected, blobRefs)
  const readOnly = daemonStatus.readOnly
  const currency = selected?.costs[0]?.currency ?? 'CNY'

  const runAction = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true)
      setActionError(null)
      try {
        await work()
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  function onCreate(intent: string) {
    void runAction(async () => {
      const created = await daemonClient.rpc<RunCreateParams, RunCreateResult>('run.create', { intent })
      setSelectedRunId(created.run_id)
    })
  }

  function onDecide(runId: string, approvalId: string, granted: boolean, note: string) {
    void runAction(() =>
      daemonClient.rpc<ApprovalDecideParams, unknown>('approval.decide', {
        run_id: runId,
        approval_id: approvalId,
        granted,
        note: note.trim() ? note : null,
      }),
    )
  }

  function onAnswer(runId: string, questionId: string, optionId: string | null, freeText: string) {
    void runAction(() =>
      daemonClient.rpc<ClarificationAnswerParams, unknown>('clarification.answer', {
        run_id: runId,
        question_id: questionId,
        option_id: optionId,
        free_text: freeText.trim() ? freeText : null,
      }),
    )
  }

  return (
    <div className="app">
      <header className="top">
        <h1>evowork</h1>
        <Composer
          connected={daemonStatus.connected}
          readOnly={readOnly}
          busy={busy}
          onCreate={onCreate}
        />
        <p className="workspace-cost">
          全部 run {formatMicros(workspaceCostMicros(view), currency)}
        </p>
      </header>

      {readOnly ? (
        <p className="banner" role="status">
          协议主版本不匹配，已降级为只读。刷新或请管理员升级 daemon。
        </p>
      ) : null}
      {actionError ? (
        <p className="banner error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="layout">
        <aside>
          <Inbox
            items={view.inbox}
            selectedRunId={selectedId}
            blobTexts={blobTexts}
            readOnly={readOnly}
            busy={busy}
            onSelectRun={setSelectedRunId}
            onDecide={onDecide}
            onAnswer={onAnswer}
          />
          <section className="run-list" data-testid="run-list">
            <h2>任务</h2>
            {view.runs.length === 0 ? (
              <p className="empty">还没有 run。声明一个意图开始。</p>
            ) : (
              <ul>
                {view.runs.map((run) => (
                  <li key={run.runId}>
                    <button
                      type="button"
                      className={run.runId === selectedId ? 'active' : ''}
                      onClick={() => setSelectedRunId(run.runId)}
                    >
                      <code>{run.runId}</code>
                      <span>{runStatusLabel(run.status)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <main>
          {selected ? (
            <>
              <div className="run-head">
                <h2>
                  <code>{selected.runId}</code>
                  <span className={`status status-${selected.status}`}>{runStatusLabel(selected.status)}</span>
                </h2>
                {selected.intentRef ? (
                  <p className="intent">{blobTexts.get(selected.intentRef.content_hash) ?? '意图正文尚未取回。'}</p>
                ) : null}
              </div>

              {selected.pendingApprovals.length > 0 ? (
                <section className="run-approvals" data-testid="run-approvals">
                  <h2>审批（{selected.pendingApprovals.length}）</h2>
                  {selected.pendingApprovals.map((approval) => (
                    <ApprovalCard
                      key={approval.approvalId}
                      approval={approval}
                      readOnly={readOnly}
                      busy={busy}
                      onDecide={(approvalId, granted, note) =>
                        onDecide(selected.runId, approvalId, granted, note)
                      }
                    />
                  ))}
                </section>
              ) : null}

              <Timeline events={selected.events} />

              <div className="split">
                <Artifacts artifacts={selected.artifacts} blobTexts={blobTexts} />
                <CostPane lines={selected.costs} currency={currency} />
              </div>
            </>
          ) : (
            <p className="empty pane-empty">
              {daemonStatus.connected
                ? '从左侧选一个任务，或在上方声明意图。'
                : 'daemon 未连接。起 evo-daemon 并带上 token（VITE_DAEMON_TOKEN 或 client.toml）后再打开。'}
            </p>
          )}
        </main>
      </div>

      <StatusBar platform={platformInfo} daemon={daemonStatus} error={daemonError} />
    </div>
  )
}
