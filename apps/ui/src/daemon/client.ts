// The one and only module the UI is allowed to use to reach the daemon.
// Everything the UI knows about daemon state flows through here: a
// request/response RPC channel for commands, and a WebSocket event
// subscription for the Run Log. There is deliberately no polling anywhere
// in this file -- the kernel is event-sourced, so the UI is a projection
// of the event stream, not a second copy of daemon state kept fresh by
// timers (design doc 06 §1 / §6).
//
// The daemon does not have an HTTP/WS entrypoint yet (that's a later
// stage) -- this module only pins down the interface, the wire types, and
// the version-negotiation rule so the call sites are already correct once
// a real daemon exists to talk to. `fetch` and `WebSocket` are both
// injectable so tests exercise this module against stubs instead of a
// live network.

import type {
  CaughtUpFrame,
  EventFrame,
  HelloFrame,
  ProtocolVersion,
  RpcRequest,
  RpcResponse,
  ServerStreamFrame,
  SubscribeFrame,
} from './types'

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
  getStatus(): DaemonClientStatus
}

/**
 * This client's own protocol version. Bump the major version only in
 * lockstep with a breaking daemon change; see design doc 06 §5.
 */
export const CLIENT_PROTOCOL_VERSION: ProtocolVersion = { major: 1, minor: 0 }

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
  return (
    typeof value === 'object' &&
    value !== null &&
    'op' in value &&
    ((value as { op: unknown }).op === 'event' || (value as { op: unknown }).op === 'caught_up')
  )
}

export function createDaemonClient(config: DaemonClientConfig): DaemonClient {
  const fetchImpl: DaemonFetchLike =
    config.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  const webSocketCtor: DaemonWebSocketCtor = config.webSocketCtor ?? GlobalWebSocketAdapter

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
    const request: RpcRequest<TParams> = { id, method, params }
    const res = await fetchImpl(`${config.baseUrl}/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(request),
    })
    if (!res.ok) {
      throw new Error(`daemonClient.rpc(${method}): HTTP ${res.status}`)
    }
    const response = (await res.json()) as RpcResponse<TResult>
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
    let lastSeq = fromSeq
    let stopped = false
    let socket: DaemonWebSocketLike | null = null

    function connect(resumeFromSeq: number): void {
      const wsUrl =
        `${toWebSocketOrigin(config.baseUrl)}/v1/events` +
        `?token=${encodeURIComponent(config.token)}`
      const ws = new webSocketCtor(wsUrl)
      socket = ws

      ws.onopen = () => {
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
          lastSeq = (parsed as EventFrame).seq
        } else {
          lastSeq = (parsed as CaughtUpFrame).at_seq
        }
        onEvent(parsed)
      }

      ws.onclose = () => {
        if (stopped) return
        // Reconnect-with-resume, never a polling fallback: pick up from
        // the last seq this subscription actually observed, so a dropped
        // connection never re-delivers events or silently skips them
        // (design doc 06 §2).
        //
        // TODO(M2, run view): no backoff, no retry-count ceiling. Against
        // a daemon that refuses every connection, this measured ~40
        // socket attempts inside 50ms (~800/s), indefinitely, and that
        // multiplies per subscription -- there is no caller today
        // (nothing in M1 calls `subscribe()` yet) so it's dormant, but
        // once the M2 run view wires this up, a daemon that goes down
        // will make the UI hammer it at that rate for as long as the
        // view stays open. Needs exponential backoff and a ceiling
        // before M2 ships this to a real run view. Tracked as a known
        // gap in docs/superpowers/notes/2026-08-29-desktop-shell-status.md.
        connect(lastSeq + 1)
      }
    }

    connect(fromSeq)

    return {
      unsubscribe(): void {
        stopped = true
        socket?.close()
      },
    }
  }

  function getStatus(): DaemonClientStatus {
    return { ...status }
  }

  return { hello, rpc, subscribe, getStatus }
}
