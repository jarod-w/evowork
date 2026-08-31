// The one and only module the UI is allowed to use to reach the daemon.
// Everything the UI knows about daemon state flows through here: a
// request/response RPC channel for commands, and a WebSocket event
// subscription for the Run Log. There is deliberately no polling anywhere
// in this file -- the kernel is event-sourced, so the UI is a projection
// of the event stream, not a second copy of daemon state kept fresh by
// timers (design doc 06 §1 / §6).
//
// Wire types come from `@evowork/protocol` (ts-rs output of evo-protocol).
// Do not re-declare them here.

import type {
  EventFrame,
  HelloFrame,
  RpcRequest,
  RpcResponse,
  ServerStreamFrame,
  SubscribeAllFrame,
  SubscribeFrame,
} from '@evowork/protocol'

// ---------------------------------------------------------------------------
// Injection seams
//
// These are intentionally *not* the full DOM `fetch`/`WebSocket` types.
// A minimal structural shape means a test's fake WebSocket only has to
// implement the handful of members this client actually touches. The
// real global `fetch` satisfies `DaemonFetchLike` as-is (a real `Response`
// only has *more* members than required here); the real global
// `WebSocket` needs a small adapter (`GlobalWebSocketAdapter` below)
// because its `onopen`/`onmessage`/`onclose` handlers carry full DOM
// `Event`/`MessageEvent`/`CloseEvent` types that don't structurally
// match this minimal shape -- no unsafe cast either way, just a wrapper.
// ---------------------------------------------------------------------------

export interface DaemonFetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type DaemonFetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<DaemonFetchResponseLike>

export interface DaemonWebSocketLike {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: ((event: { code: number; wasClean: boolean }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface DaemonWebSocketCtor {
  new (url: string): DaemonWebSocketLike
}

// ---------------------------------------------------------------------------
// Public client surface
// ---------------------------------------------------------------------------

export interface DaemonClientConfig {
  baseUrl: string
  token: string
  /** Defaults to the global `fetch`. Override in tests with a stub. */
  fetchImpl?: DaemonFetchLike
  /** Defaults to the global `WebSocket`. Override in tests with a stub. */
  webSocketCtor?: DaemonWebSocketCtor
  /**
   * Used by `subscribe()` to delay reconnects. Defaults to `setTimeout`.
   * Tests inject a queue so backoff is deterministic and not wall-clock.
   */
  schedule?: (fn: () => void, ms: number) => unknown
  cancelSchedule?: (handle: unknown) => void
}

export interface DaemonClientStatus {
  /** True once `hello()` has completed successfully at least once. */
  connected: boolean
  /**
   * True when the daemon's major protocol version doesn't match this
   * client's (design doc 06 §5, Q-23). While true, `rpc()` rejects every
   * write method locally, without making a network call.
   */
  readOnly: boolean
  protocolVersion: ProtocolVersion | null
}

export interface DaemonSubscription {
  /**
   * Stops the subscription and, critically, stops the automatic
   * reconnect-with-resume behavior -- a socket closed via `unsubscribe()`
   * is a deliberate stop, not a dropped connection.
   */
  unsubscribe(): void
}

export interface DaemonClient {
  /**
   * Fetches the daemon's greeting and negotiates the protocol version.
   * Must be called (and must succeed) before `readOnly` reflects
   * anything other than its optimistic default.
   */
  hello(): Promise<HelloFrame>
  /** Calls one JSON-RPC method (design doc 06 §3). */
  rpc<TParams, TResult>(method: string, params: TParams): Promise<TResult>
  /**
   * Subscribes to one run's event stream, resuming from `fromSeq` and
   * onward. Reconnects automatically on an unexpected drop, resuming
   * from the last seq actually observed -- never from the start, and
   * never by polling.
   */
  subscribe(
    runId: string,
    fromSeq: number,
    onEvent: (frame: ServerStreamFrame) => void,
  ): DaemonSubscription
  /**
   * Subscribes to every run's event stream (design doc 06 §2). Inbox and
   * the cost panel are projections of this global log, not of a second
   * store. Reconnects with the same backoff as `subscribe()`.
   *
   * Resume is always `from_seq: 0`. The subscribe_all frame only carries
   * one seq, which the daemon applies independently to each run — sending
   * the last seq observed on run A would skip every earlier seq on run B.
   * The UI fold is idempotent per `(run_id, seq)`, so replaying from 0
   * after a drop does not double-count.
   */
  subscribeAll(onEvent: (frame: ServerStreamFrame) => void): DaemonSubscription
  getStatus(): DaemonClientStatus
}

/**
 * This client's own protocol version. Bump the major version only in
 * lockstep with a breaking daemon change; see design doc 06 §5.
 */
export const CLIENT_PROTOCOL_VERSION: ProtocolVersion = { major: 1, minor: 0 }

/** First reconnect wait. Doubles each attempt up to `SUBSCRIBE_MAX_BACKOFF_MS`. */
export const SUBSCRIBE_INITIAL_BACKOFF_MS = 200
export const SUBSCRIBE_MAX_BACKOFF_MS = 10_000
/** After this many failed reconnects, `subscribe()` stops. Unsubscribe still works. */
export const SUBSCRIBE_MAX_RETRIES = 20

export interface ProtocolVersion {
  major: number
  minor: number
}

/**
 * RPC methods that only read state (design doc 06 §3). Everything *not*
 * on this list is treated as a write and is rejected while the client is
 * read-only -- an allowlist, not a denylist, on purpose: an unrecognized
 * method (e.g. one added to the protocol after this list was written)
 * fails closed instead of silently being allowed to mutate state through
 * a stale UI.
 */
const READ_ONLY_SAFE_METHODS: ReadonlySet<string> = new Set([
  'run.list',
  'run.get',
  'run.events',
  'artifact.list',
  'artifact.download',
  'blob.get',
  'cost.query',
  'tool.list',
  'tool.manifest',
  'policy.get',
  'trigger.list',
  'trigger.dryrun',
])

export class DaemonReadOnlyError extends Error {
  constructor(method: string) {
    super(
      `daemonClient is read-only (protocol major-version mismatch with the ` +
        `daemon) -- refusing to call write method "${method}". Reload once ` +
        `the daemon has been upgraded to match, or contact an administrator.`,
    )
    this.name = 'DaemonReadOnlyError'
  }
}

export class DaemonRpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'DaemonRpcError'
    this.code = code
  }
}

function parseProtocolVersion(raw: string): ProtocolVersion {
  const match = /^(\d+)\.(\d+)$/.exec(raw)
  if (!match) {
    throw new Error(`daemonClient: malformed protocol_ver "${raw}"`)
  }
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/** `http(s)://…` -> `ws(s)://…`. The path/query are appended by callers. */
function toWebSocketOrigin(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`
  throw new Error(`daemonClient: baseUrl must start with http:// or https:// (got "${baseUrl}")`)
}

/**
 * Adapts the real global `WebSocket` (whose event-handler properties carry
 * full DOM `Event`/`MessageEvent`/`CloseEvent` types) to `DaemonWebSocketLike`.
 * Written as an explicit adapter -- rather than asserting the DOM
 * `WebSocket` class itself satisfies `DaemonWebSocketCtor` -- because the
 * DOM handler signatures are strictly wider (they carry full Event
 * objects), and TypeScript correctly refuses to treat "accepts a full
 * Event" as interchangeable with "accepts our minimal shape" when the
 * property is compared structurally in the other direction.
 */
class GlobalWebSocketAdapter implements DaemonWebSocketLike {
  private readonly real: WebSocket
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(url: string) {
    this.real = new WebSocket(url)
    this.real.onopen = () => this.onopen?.()
    this.real.onmessage = (event) => this.onmessage?.({ data: String(event.data) })
    this.real.onclose = (event) =>
      this.onclose?.({ code: event.code, wasClean: event.wasClean })
    this.real.onerror = (event) => this.onerror?.(event)
  }

  get readyState(): number {
    return this.real.readyState
  }

  send(data: string): void {
    this.real.send(data)
  }

  close(code?: number, reason?: string): void {
    this.real.close(code, reason)
  }
}

function isServerStreamFrame(value: unknown): value is ServerStreamFrame {
  if (typeof value !== 'object' || value === null || !('op' in value)) return false
  const op = (value as { op: unknown }).op
  if (op === 'event') return 'event' in value
  if (op === 'caught_up') return 'run_id' in value && 'at_seq' in value
  return false
}

export function createDaemonClient(config: DaemonClientConfig): DaemonClient {
  const fetchImpl: DaemonFetchLike =
    config.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  const webSocketCtor: DaemonWebSocketCtor = config.webSocketCtor ?? GlobalWebSocketAdapter
  const schedule = config.schedule ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const cancelSchedule =
    config.cancelSchedule ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>))

  let nextRequestId = 1
  const status: DaemonClientStatus = {
    connected: false,
    readOnly: false,
    protocolVersion: null,
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${config.token}` }
  }

  async function hello(): Promise<HelloFrame> {
    const res = await fetchImpl(`${config.baseUrl}/v1/hello`, { headers: authHeaders() })
    if (!res.ok) {
      throw new Error(`daemonClient.hello(): HTTP ${res.status}`)
    }
    const frame = (await res.json()) as HelloFrame
    const daemonVersion = parseProtocolVersion(frame.protocol_ver)

    status.connected = true
    status.protocolVersion = daemonVersion
    status.readOnly = daemonVersion.major !== CLIENT_PROTOCOL_VERSION.major

    return frame
  }

  async function rpc<TParams, TResult>(method: string, params: TParams): Promise<TResult> {
    if (status.readOnly && !READ_ONLY_SAFE_METHODS.has(method)) {
      throw new DaemonReadOnlyError(method)
    }

    const id = nextRequestId++
    const request: RpcRequest = { id, method, params: params as unknown }
    const res = await fetchImpl(`${config.baseUrl}/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(request),
    })
    if (!res.ok) {
      throw new Error(`daemonClient.rpc(${method}): HTTP ${res.status}`)
    }
    const response = (await res.json()) as RpcResponse
    if (response.error) {
      throw new DaemonRpcError(response.error.code, response.error.message)
    }
    return response.result as TResult
  }

  function subscribe(
    runId: string,
    fromSeq: number,
    onEvent: (frame: ServerStreamFrame) => void,
  ): DaemonSubscription {
    let lastObservedSeq: number | null = null
    let stopped = false
    let socket: DaemonWebSocketLike | null = null
    let reconnectAttempt = 0
    let reconnectHandle: unknown = null

    function nextFromSeq(): number {
      return lastObservedSeq === null ? fromSeq : lastObservedSeq + 1
    }

    function connect(resumeFromSeq: number): void {
      const wsUrl =
        `${toWebSocketOrigin(config.baseUrl)}/v1/events` +
        `?token=${encodeURIComponent(config.token)}`
      const ws = new webSocketCtor(wsUrl)
      socket = ws

      ws.onopen = () => {
        reconnectAttempt = 0
        const frame: SubscribeFrame = {
          op: 'subscribe',
          run_id: runId,
          from_seq: resumeFromSeq,
        }
        ws.send(JSON.stringify(frame))
      }

      ws.onmessage = (event) => {
        const parsed: unknown = JSON.parse(event.data)
        if (!isServerStreamFrame(parsed)) return

        if (parsed.op === 'event') {
          lastObservedSeq = (parsed as EventFrame).event.seq
        }
        onEvent(parsed)
      }

      ws.onclose = () => {
        if (stopped) return
        if (reconnectAttempt >= SUBSCRIBE_MAX_RETRIES) return
        const delay = Math.min(
          SUBSCRIBE_INITIAL_BACKOFF_MS * 2 ** reconnectAttempt,
          SUBSCRIBE_MAX_BACKOFF_MS,
        )
        reconnectAttempt += 1
        reconnectHandle = schedule(() => {
          reconnectHandle = null
          if (stopped) return
          connect(nextFromSeq())
        }, delay)
      }
    }

    connect(fromSeq)

    return {
      unsubscribe(): void {
        stopped = true
        if (reconnectHandle !== null) {
          cancelSchedule(reconnectHandle)
          reconnectHandle = null
        }
        socket?.close()
      },
    }
  }

  function subscribeAll(onEvent: (frame: ServerStreamFrame) => void): DaemonSubscription {
    // See the method doc on `DaemonClient.subscribeAll`: a single
    // from_seq cannot resume N runs, so every connect (including
    // reconnect) asks for the full backlog.
    let stopped = false
    let socket: DaemonWebSocketLike | null = null
    let reconnectAttempt = 0
    let reconnectHandle: unknown = null

    function connect(): void {
      const wsUrl =
        `${toWebSocketOrigin(config.baseUrl)}/v1/events` +
        `?token=${encodeURIComponent(config.token)}`
      const ws = new webSocketCtor(wsUrl)
      socket = ws

      ws.onopen = () => {
        reconnectAttempt = 0
        const frame: SubscribeAllFrame = {
          op: 'subscribe_all',
          from_seq: 0,
        }
        ws.send(JSON.stringify(frame))
      }

      ws.onmessage = (event) => {
        const parsed: unknown = JSON.parse(event.data)
        if (!isServerStreamFrame(parsed)) return
        onEvent(parsed)
      }

      ws.onclose = () => {
        if (stopped) return
        if (reconnectAttempt >= SUBSCRIBE_MAX_RETRIES) return
        const delay = Math.min(
          SUBSCRIBE_INITIAL_BACKOFF_MS * 2 ** reconnectAttempt,
          SUBSCRIBE_MAX_BACKOFF_MS,
        )
        reconnectAttempt += 1
        reconnectHandle = schedule(() => {
          reconnectHandle = null
          if (stopped) return
          connect()
        }, delay)
      }
    }

    connect()

    return {
      unsubscribe(): void {
        stopped = true
        if (reconnectHandle !== null) {
          cancelSchedule(reconnectHandle)
          reconnectHandle = null
        }
        socket?.close()
      },
    }
  }

  function getStatus(): DaemonClientStatus {
    return { ...status }
  }

  return { hello, rpc, subscribe, subscribeAll, getStatus }
}
