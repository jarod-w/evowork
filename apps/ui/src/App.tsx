import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ApprovalDecideParams,
  BudgetAmendParams,
  ClarificationAnswerParams,
  Event,
  RunCreateParams,
  RunCreateResult,
  ServerStreamFrame,
} from '@evowork/protocol'

import { createDaemonClient } from './daemon/client'
import type { DaemonClient, DaemonClientStatus } from './daemon/client'
import {
  DEFAULT_DAEMON_URL,
  clearSavedConfig,
  loadSavedConfig,
  parseClientToml,
  resolveDaemonConfig,
  saveConfig,
} from './daemon/config'
import type {
  DaemonConnectionConfig,
  DaemonSettingsStorage,
  ResolvedDaemonConfig,
} from './daemon/config'
import { getPlatform } from './platform'
import type { Platform, PlatformInfo } from './platform'
import { applyEvent, emptyWorkspace, workspaceCostMicros } from './projection/fold'
import type { RunView, WorkspaceView } from './projection/fold'
import { formatMicros, awaitingLabel, runStatusLabel } from './projection/format'
import { Artifacts } from './workspace/Artifacts'
import { BudgetCard } from './workspace/BudgetCard'
import type { BudgetAmendPayload } from './workspace/BudgetCard'
import { Composer } from './workspace/Composer'
import { CostPane } from './workspace/CostPane'
import { DaemonSettings } from './workspace/DaemonSettings'
import { Inbox } from './workspace/Inbox'
import { StatusBar } from './workspace/StatusBar'
import { Timeline } from './workspace/Timeline'
import { useBlobTexts } from './workspace/useBlobTexts'
import { ApprovalCard } from './workspace/ApprovalCard'

/**
 * Build-time settings, i.e. how the browser/dev entry has always been
 * configured: `VITE_DAEMON_TOKEN=… pnpm dev`.
 *
 * Returns `null` when NEITHER variable is set, so `resolveDaemonConfig`
 * can fall through to `client.toml` instead of being handed an empty
 * token dressed up as a configured one. That distinction is the whole of
 * P0-17: the packaged `.app` was built with neither variable set, and the
 * old code turned that into `{ baseUrl: 'http://localhost:4477', token:
 * '' }` -- a settings pair that looks configured, is not, and produces a
 * 401 against every daemon.
 *
 * When only the token is set, the URL is filled from the default. That
 * keeps the documented dev flow (which sets only `VITE_DAEMON_TOKEN`)
 * working as a complete source rather than a half-filled one that
 * `resolveDaemonConfig` would skip for having no URL.
 */
function buildTimeConfig(): Partial<DaemonConnectionConfig> | null {
  const baseUrl: string | undefined = import.meta.env.VITE_DAEMON_URL
  const token: string | undefined = import.meta.env.VITE_DAEMON_TOKEN
  if (baseUrl === undefined && token === undefined) return null
  return { baseUrl: baseUrl ?? DEFAULT_DAEMON_URL, token: token ?? '' }
}

/**
 * `localStorage`, or `null` where merely touching it throws (Safari
 * private browsing, site data blocked by policy). Deliberately does NOT
 * substitute an in-memory Map: settings that look saved and silently
 * evaporate on reload are worse than settings that report they could not
 * be saved, which is what `App` does with a `null` here.
 */
function browserStorage(): DaemonSettingsStorage | null {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

interface AppProps {
  /**
   * Tests inject a stub. Production leaves this unset, and the client is
   * built from resolved settings instead (see `createClient`).
   */
  client?: DaemonClient
  /**
   * Builds a client from resolved settings. Production leaves this unset.
   * Tests that exercise the settings panel override it to observe which
   * settings a save actually reconnected with.
   */
  createClient?: (config: DaemonConnectionConfig) => DaemonClient
  /** Tests inject a stub; production uses `localStorage`. */
  storage?: DaemonSettingsStorage | null
  /**
   * Tests inject a fake shell. Production leaves this unset and
   * `getPlatform()` decides.
   *
   * This seam exists so the desktop `client.toml` path can be tested at
   * the `App` level WITHOUT importing Tauri's JS binding packages into a
   * test file outside `platform/`. CI-9 forbids that import anywhere else
   * under `apps/ui/src/`, and it is right to: a test that reaches for
   * those packages directly is one refactor away from production code
   * doing the same. Injecting the `Platform` interface instead tests the
   * wiring this file owns (check `supports()`, then read, then resolve)
   * and leaves the bindings themselves to `platform/index.test.ts`.
   *
   * Note CI-9 matches the package scope as TEXT, so it flags the literal
   * even inside a comment -- which is why this paragraph describes the
   * packages in prose. That is the check being blunt, not wrong: making
   * it distinguish comments from imports would mean parsing, and the
   * bypass that opens is the one its last fix closed.
   */
  platform?: Platform & { info: PlatformInfo }
}

export default function App({ client, createClient, storage, platform }: AppProps) {
  const settingsStorage = useMemo(
    () => (storage === undefined ? browserStorage() : storage),
    [storage],
  )

  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  /** `null` until the bootstrap effect below has resolved the settings. */
  const [config, setConfig] = useState<ResolvedDaemonConfig | null>(null)
  const [clientToml, setClientToml] = useState<Partial<DaemonConnectionConfig> | null>(null)
  const [hasSavedConfig, setHasSavedConfig] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * Bumped by every save/clear so that pressing 重连 with UNCHANGED
   * settings still tears down the old client and runs `hello()` again.
   * Without it the `useMemo` below would hand back the same client and
   * the button would do nothing -- a "reconnect" that does not reconnect.
   */
  const [connectNonce, setConnectNonce] = useState(0)

  const daemonClient = useMemo(() => {
    if (client) return client
    if (!config) return null
    const build = createClient ?? createDaemonClient
    return build({ baseUrl: config.baseUrl, token: config.token })
    // `connectNonce` is in the dependency list without being read in the
    // body, on purpose -- see its declaration above.
  }, [client, createClient, config?.baseUrl, config?.token, connectNonce])

  const [daemonStatus, setDaemonStatus] = useState<DaemonClientStatus>({
    connected: false,
    readOnly: false,
    protocolVersion: null,
  })
  const [daemonError, setDaemonError] = useState<string | null>(null)
  const [view, setView] = useState<WorkspaceView>(emptyWorkspace)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Bootstrap: resolve the shell, then the daemon settings, in that
  // order -- reading `~/.evowork/client.toml` is a platform capability,
  // so the settings cannot be resolved until the shell is known. Runs
  // once; every later change to the settings goes through
  // `onSaveSettings` / `onClearSettings` instead.
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const resolvedPlatform = platform ?? (await getPlatform())
      if (cancelled) return
      setPlatformInfo(resolvedPlatform.info)

      // `supports()` first, then the call. The browser shell THROWS from
      // `readClientToml()` rather than returning null (see
      // platform/browser.ts for why that asymmetry is deliberate), so
      // calling it unguarded here would turn "this is a web page" into an
      // unhandled rejection.
      let toml: Partial<DaemonConnectionConfig> | null = null
      if (resolvedPlatform.info.supports('readClientToml')) {
        const raw = await resolvedPlatform.readClientToml()
        if (cancelled) return
        if (raw !== null) toml = parseClientToml(raw)
      }

      const saved = settingsStorage ? loadSavedConfig(settingsStorage) : null
      if (cancelled) return
      setClientToml(toml)
      setHasSavedConfig(saved !== null)
      setConfig(resolveDaemonConfig({ saved, buildTime: buildTimeConfig(), clientToml: toml }))
    })()

    return () => {
      cancelled = true
    }
  }, [settingsStorage, platform])

  useEffect(() => {
    if (!daemonClient) return
    // A new client means either different settings or a deliberate
    // reconnect. Drop the projection built from the previous stream
    // rather than folding two daemons' logs into one view -- `run_id`s
    // are only unique within a daemon, so keeping the old runs would
    // silently mix them.
    setView(emptyWorkspace())
    setDaemonStatus({ connected: false, readOnly: false, protocolVersion: null })
    setSelectedRunId(null)

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

  /**
   * The settings panel is forced open while there is no connection. Not
   * a nicety: P0-17's third bullet was that the installed artifact
   * offered no way to fix its settings, and a panel you have to know to
   * go looking for is the same defect with one more click in front of
   * it. Once connected it collapses to the header's 设置 button.
   *
   * `config === null` means the bootstrap effect has not finished, so
   * there is nothing to show yet -- the panel's inputs would seed
   * themselves from settings that do not exist.
   */
  const showSettings = config !== null && (settingsOpen || !daemonStatus.connected)

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

  /**
   * The client, or a thrown error. `daemonClient` is `null` only while
   * the bootstrap effect is still resolving the settings, and every
   * caller below is behind a control that is disabled until
   * `daemonStatus.connected` -- so reaching this throw means a control
   * became live before there was a client, which is a bug worth
   * surfacing through `runAction`'s error banner rather than papering
   * over with a silent no-op.
   */
  function requireClient(): DaemonClient {
    if (!daemonClient) {
      throw new Error('daemon 设置尚未就绪（还没有建立连接）。稍后再试，或在「daemon 连接」里检查设置。')
    }
    return daemonClient
  }

  function onSaveSettings(next: DaemonConnectionConfig) {
    setSettingsError(null)
    if (settingsStorage) {
      try {
        saveConfig(settingsStorage, next)
        setHasSavedConfig(true)
      } catch (err: unknown) {
        // Applied for this session but not persisted. Say so, rather
        // than reporting a save that did not happen.
        setSettingsError(
          `设置已生效，但没能存下来（刷新后会丢）：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      setSettingsError('设置已生效，但这个环境不允许保存（localStorage 不可用），刷新后会丢。')
    }
    setConfig({ ...next, source: 'saved' })
    setConnectNonce((n) => n + 1)
  }

  function onClearSettings() {
    setSettingsError(null)
    if (settingsStorage) {
      try {
        clearSavedConfig(settingsStorage)
      } catch (err: unknown) {
        setSettingsError(
          `没能清除已保存的设置：${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
    }
    setHasSavedConfig(false)
    // Re-resolve from the remaining sources, so clearing lands on
    // whatever would have been used had nothing ever been saved.
    setConfig(resolveDaemonConfig({ saved: null, buildTime: buildTimeConfig(), clientToml }))
    setConnectNonce((n) => n + 1)
  }

  function onCreate(intent: string) {
    void runAction(async () => {
      const created = await requireClient().rpc<RunCreateParams, RunCreateResult>('run.create', { intent })
      setSelectedRunId(created.run_id)
    })
  }

  function onDecide(runId: string, approvalId: string, granted: boolean, note: string) {
    void runAction(() =>
      requireClient().rpc<ApprovalDecideParams, unknown>('approval.decide', {
        run_id: runId,
        approval_id: approvalId,
        granted,
        note: note.trim() ? note : null,
      }),
    )
  }

  function onAnswer(runId: string, questionId: string, optionId: string | null, freeText: string) {
    void runAction(() =>
      requireClient().rpc<ClarificationAnswerParams, unknown>('clarification.answer', {
        run_id: runId,
        question_id: questionId,
        option_id: optionId,
        free_text: freeText.trim() ? freeText : null,
      }),
    )
  }

  function onAmendBudget(runId: string, payload: BudgetAmendPayload) {
    void runAction(() =>
      requireClient().rpc<BudgetAmendParams, unknown>('budget.amend', {
        run_id: runId,
        budget: payload.budget,
        reason: payload.reason.trim() ? payload.reason : null,
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
        <button
          type="button"
          className="settings-toggle"
          data-testid="settings-toggle"
          aria-expanded={showSettings}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          设置
        </button>
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
            runs={view.runs}
            selectedRunId={selectedId}
            blobTexts={blobTexts}
            readOnly={readOnly}
            busy={busy}
            onSelectRun={setSelectedRunId}
            onDecide={onDecide}
            onAnswer={onAnswer}
            onAmendBudget={onAmendBudget}
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
                      {run.awaiting ? <span className="muted"> · {awaitingLabel(run.awaiting)}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <main>
          {showSettings && config ? (
            <DaemonSettings
              // Remount when the settings in use change, so the form's
              // inputs re-seed from them. See DaemonSettings' own note.
              key={`${config.baseUrl} ${config.token}`}
              config={config}
              clientToml={clientToml}
              clientTomlSupported={platformInfo?.supports('readClientToml') ?? false}
              hasSavedConfig={hasSavedConfig}
              error={settingsError ?? daemonError}
              onSave={onSaveSettings}
              onClear={onClearSettings}
            />
          ) : null}

          {selected ? (
            <>
              <div className="run-head">
                <h2>
                  <code>{selected.runId}</code>
                  <span className={`status status-${selected.status}`}>{runStatusLabel(selected.status)}</span>
                  {selected.awaiting ? (
                    <span className="status status-suspended">{awaitingLabel(selected.awaiting)}</span>
                  ) : null}
                </h2>
                {selected.intentRef ? (
                  <p className="intent">{blobTexts.get(selected.intentRef.content_hash) ?? '意图正文尚未取回。'}</p>
                ) : null}
              </div>

              {selected.awaiting === 'budget_exhausted' ? (
                <section className="run-budget" data-testid="run-budget">
                  <h2>预算</h2>
                  <BudgetCard
                    budget={selected.budget}
                    used={selected.budgetUsed}
                    currency={currency}
                    readOnly={readOnly}
                    busy={busy}
                    onAmend={(payload) => onAmendBudget(selected.runId, payload)}
                  />
                </section>
              ) : null}

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

              <Timeline events={selected.events} checkpoints={selected.checkpoints} />

              <div className="split">
                <Artifacts artifacts={selected.artifacts} blobTexts={blobTexts} />
                <CostPane
                  lines={selected.costs}
                  currency={currency}
                  budget={selected.budget}
                  used={selected.budgetUsed}
                />
              </div>
            </>
          ) : (
            <p className="empty pane-empty">
              {daemonStatus.connected
                ? '从左侧选一个任务，或在上方声明意图。'
                : 'daemon 未连接。在上面的「daemon 连接」里填 URL 和 token。'}
            </p>
          )}
        </main>
      </div>

      <StatusBar platform={platformInfo} daemon={daemonStatus} error={daemonError} />
    </div>
  )
}
