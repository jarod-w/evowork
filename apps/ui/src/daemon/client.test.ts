import { describe, expect, it, vi } from 'vitest'

import type { EventFrame, HelloFrame, ServerStreamFrame } from '@evowork/protocol'
import {
  createDaemonClient,
  DaemonReadOnlyError,
  DaemonRpcError,
  SUBSCRIBE_INITIAL_BACKOFF_MS,
  SUBSCRIBE_MAX_RETRIES,
  type DaemonFetchResponseLike,
  type DaemonWebSocketCtor,
  type DaemonWebSocketLike,
} from './client'

// ---------------------------------------------------------------------------
// Test doubles. Neither a real daemon nor a real network exists yet (that's
// a later stage) -- this exercises the client entirely against injected
// stubs, per the task brief.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, ok = true, status = 200): DaemonFetchResponseLike {
  return { ok, status, json: () => Promise.resolve(body) }
}

function helloFrame(protocolVer: string): HelloFrame {
  return { op: 'hello', protocol_ver: protocolVer, daemon_ver: '0.4.2', runlog_schema_ver: 1 }
}

interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

function fakeFetch(handler: (url: string, init?: FetchInit) => Promise<DaemonFetchResponseLike>) {
  return vi.fn(handler)
}

class FakeWebSocket implements DaemonWebSocketLike {
  static instances: FakeWebSocket[] = []
  readonly url: string
  readonly sent: string[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.({ code: 1000, wasClean: true })
  }

  /** Test helper: simulate the server accepting the connection. */
  simulateOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  /** Test helper: simulate a pushed server frame. */
  simulateMessage(frame: ServerStreamFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** Test helper: simulate the connection dropping unexpectedly. */
  simulateDrop(): void {
    this.readyState = 3
    this.onclose?.({ code: 1006, wasClean: false })
  }
}

function freshFakeWebSocketCtor(): DaemonWebSocketCtor {
  FakeWebSocket.instances = []
  return FakeWebSocket
}

function eventFrame(runId: string, seq: number, kind: string): EventFrame {
  return {
    op: 'event',
    event: {
      run_id: runId,
      seq,
      recorded_at: 't',
      actor: 'runtime',
      schema_ver: 1,
      body: { kind } as EventFrame['event']['body'],
    },
  }
}

interface ScheduledReconnect {
  fn: () => void
  ms: number
  cancelled: boolean
}

function queuedScheduler() {
  const queued: ScheduledReconnect[] = []
  const delays: number[] = []
  return {
    delays,
    schedule: (fn: () => void, ms: number) => {
      const item: ScheduledReconnect = { fn, ms, cancelled: false }
      queued.push(item)
      delays.push(ms)
      return item
    },
    cancelSchedule: (handle: unknown) => {
      ;(handle as ScheduledReconnect).cancelled = true
    },
    fireNext() {
      const item = queued.shift()
      if (!item || item.cancelled) return
      item.fn()
    },
    pending() {
      return queued.filter((item) => !item.cancelled).length
    },
  }
}

describe('createDaemonClient()', () => {
  describe('hello() / version negotiation (design doc 06 §5, Q-23)', () => {
    it('matching major and minor: connected, not read-only', async () => {
      const fetchImpl = fakeFetch(() => Promise.resolve(jsonResponse(helloFrame('1.0'))))
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })

      const frame = await client.hello()

      expect(frame.protocol_ver).toBe('1.0')
      expect(client.getStatus()).toEqual({
        connected: true,
        readOnly: false,
        protocolVersion: { major: 1, minor: 0 },
      })
    })

    it('minor mismatch only: connected, still NOT read-only', async () => {
      const fetchImpl = fakeFetch(() => Promise.resolve(jsonResponse(helloFrame('1.7'))))
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })

      await client.hello()

      expect(client.getStatus().connected).toBe(true)
      expect(client.getStatus().readOnly).toBe(false)
    })

    it('major mismatch: connected, but degrades to read-only', async () => {
      const fetchImpl = fakeFetch(() => Promise.resolve(jsonResponse(helloFrame('2.0'))))
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })

      await client.hello()

      expect(client.getStatus()).toEqual({
        connected: true,
        readOnly: true,
        protocolVersion: { major: 2, minor: 0 },
      })
    })

    it('before hello() resolves, status is the optimistic not-connected default', () => {
      const fetchImpl = fakeFetch(() => new Promise<DaemonFetchResponseLike>(() => {}))
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })

      expect(client.getStatus()).toEqual({
        connected: false,
        readOnly: false,
        protocolVersion: null,
      })
    })

    it('a failed HTTP response surfaces as a rejected promise, not a silent read-only flip', async () => {
      const fetchImpl = fakeFetch(() => Promise.resolve(jsonResponse(null, false, 503)))
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })

      await expect(client.hello()).rejects.toThrow(/503/)
      expect(client.getStatus().connected).toBe(false)
    })
  })

  describe('rpc()', () => {
    it('posts to /v1/rpc with the bearer token and returns the result', async () => {
      const fetchImpl = fakeFetch((url) => {
        expect(url).toBe('http://localhost:4000/v1/rpc')
        return Promise.resolve(jsonResponse({ id: 1, result: { runs: [] } }))
      })
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'secret-token',
        fetchImpl,
      })

      const result = await client.rpc('run.list', {})

      expect(result).toEqual({ runs: [] })
      const call = fetchImpl.mock.calls[0]
      const init = call[1]
      expect(init?.headers?.Authorization).toBe('Bearer secret-token')
      expect(JSON.parse(init?.body ?? '')).toEqual({ id: 1, method: 'run.list', params: {} })
    })

    it('throws DaemonRpcError when the response carries an error body', async () => {
      const fetchImpl = fakeFetch(() =>
        Promise.resolve(jsonResponse({ id: 1, error: { code: 404, message: 'run not found' } })),
      )
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })

      await expect(client.rpc('run.get', { run_id: 'r-1' })).rejects.toThrow(DaemonRpcError)
      await expect(client.rpc('run.get', { run_id: 'r-1' })).rejects.toThrow(/run not found/)
    })

    it('read methods work normally before hello() has ever been called', async () => {
      const fetchImpl = fakeFetch(() => Promise.resolve(jsonResponse({ id: 1, result: 'ok' })))
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })

      await expect(client.rpc('run.list', {})).resolves.toBe('ok')
    })

    it('a major-version mismatch rejects a write method WITHOUT making a network call', async () => {
      const fetchImpl = fakeFetch(() => Promise.resolve(jsonResponse(helloFrame('99.0'))))
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })
      await client.hello()
      expect(client.getStatus().readOnly).toBe(true)

      const callCountBefore = fetchImpl.mock.calls.length

      await expect(client.rpc('run.create', { intent: 'x' })).rejects.toThrow(DaemonReadOnlyError)
      expect(fetchImpl.mock.calls.length).toBe(callCountBefore)
    })

    it('a major-version mismatch still allows an allowlisted read method through', async () => {
      const fetchImpl = fakeFetch((url) => {
        if (url.endsWith('/v1/hello')) return Promise.resolve(jsonResponse(helloFrame('99.0')))
        return Promise.resolve(jsonResponse({ id: 1, result: { runs: [] } }))
      })
      const client = createDaemonClient({ baseUrl: 'http://localhost:4000', token: 't', fetchImpl })
      await client.hello()

      await expect(client.rpc('run.list', {})).resolves.toEqual({ runs: [] })
    })
  })

  describe('subscribe() (design doc 06 §2 -- WebSocket, from_seq resume, no polling)', () => {
    it('opens a WS to <baseUrl>/v1/events with the token, and subscribes on open', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
      })

      client.subscribe('r-1', 0, () => {})

      expect(FakeWebSocket.instances).toHaveLength(1)
      const ws = FakeWebSocket.instances[0]
      expect(ws.url).toBe('ws://localhost:4000/v1/events?token=tok')

      ws.simulateOpen()
      expect(ws.sent).toEqual([JSON.stringify({ op: 'subscribe', run_id: 'r-1', from_seq: 0 })])
    })

    it('uses wss:// for an https:// baseUrl', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const client = createDaemonClient({
        baseUrl: 'https://daemon.example',
        token: 'tok',
        webSocketCtor,
      })

      client.subscribe('r-1', 0, () => {})

      expect(FakeWebSocket.instances[0].url).toBe('wss://daemon.example/v1/events?token=tok')
    })

    it('delivers event and caught_up frames to onEvent', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
      })
      const received: ServerStreamFrame[] = []
      client.subscribe('r-1', 0, (frame) => received.push(frame))
      const ws = FakeWebSocket.instances[0]
      ws.simulateOpen()

      const evt = eventFrame('r-1', 0, 'run.created')
      ws.simulateMessage(evt)
      ws.simulateMessage({ op: 'caught_up', run_id: 'r-1', at_seq: 0 })

      expect(received).toEqual([evt, { op: 'caught_up', run_id: 'r-1', at_seq: 0 }])
    })

    it('on an unexpected drop, reconnects after backoff and resumes from the last seq seen', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const scheduler = queuedScheduler()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
        schedule: scheduler.schedule,
        cancelSchedule: scheduler.cancelSchedule,
      })
      client.subscribe('r-1', 0, () => {})

      const first = FakeWebSocket.instances[0]
      first.simulateOpen()
      first.simulateMessage(eventFrame('r-1', 0, 'run.created'))
      first.simulateMessage(eventFrame('r-1', 1, 'intent.declared'))

      first.simulateDrop()
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(scheduler.delays).toEqual([SUBSCRIBE_INITIAL_BACKOFF_MS])

      scheduler.fireNext()
      expect(FakeWebSocket.instances).toHaveLength(2)
      const second = FakeWebSocket.instances[1]
      second.simulateOpen()
      expect(second.sent).toEqual([
        JSON.stringify({ op: 'subscribe', run_id: 'r-1', from_seq: 2 }),
      ])
    })

    it('doubles the reconnect delay on each failure (P0-16)', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const scheduler = queuedScheduler()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
        schedule: scheduler.schedule,
        cancelSchedule: scheduler.cancelSchedule,
      })
      client.subscribe('r-1', 0, () => {})

      FakeWebSocket.instances[0].simulateDrop()
      scheduler.fireNext()
      FakeWebSocket.instances[1].simulateDrop()
      scheduler.fireNext()
      FakeWebSocket.instances[2].simulateDrop()

      expect(scheduler.delays).toEqual([
        SUBSCRIBE_INITIAL_BACKOFF_MS,
        SUBSCRIBE_INITIAL_BACKOFF_MS * 2,
        SUBSCRIBE_INITIAL_BACKOFF_MS * 4,
      ])
    })

    it('stops reconnecting after SUBSCRIBE_MAX_RETRIES (P0-16)', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const scheduler = queuedScheduler()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
        schedule: scheduler.schedule,
        cancelSchedule: scheduler.cancelSchedule,
      })
      client.subscribe('r-1', 0, () => {})

      for (let i = 0; i < SUBSCRIBE_MAX_RETRIES; i++) {
        FakeWebSocket.instances.at(-1)?.simulateDrop()
        scheduler.fireNext()
      }
      const socketsAfterCeiling = FakeWebSocket.instances.length
      FakeWebSocket.instances.at(-1)?.simulateDrop()
      expect(scheduler.pending()).toBe(0)
      expect(FakeWebSocket.instances).toHaveLength(socketsAfterCeiling)
    })

    it('unsubscribe() closes the socket and does not trigger a reconnect', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const scheduler = queuedScheduler()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
        schedule: scheduler.schedule,
        cancelSchedule: scheduler.cancelSchedule,
      })
      const subscription = client.subscribe('r-1', 0, () => {})
      FakeWebSocket.instances[0].simulateOpen()

      subscription.unsubscribe()

      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(scheduler.pending()).toBe(0)
    })
  })

  describe('subscribeAll() (design doc 06 §2 -- Inbox / cost panel)', () => {
    it('sends subscribe_all from_seq 0 on open', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
      })
      client.subscribeAll(() => {})
      FakeWebSocket.instances[0].simulateOpen()
      expect(FakeWebSocket.instances[0].sent).toEqual([
        JSON.stringify({ op: 'subscribe_all', from_seq: 0 }),
      ])
    })

    it('reconnects from from_seq 0 even after seeing a high seq (one seq cannot resume N runs)', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const scheduler = queuedScheduler()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
        schedule: scheduler.schedule,
        cancelSchedule: scheduler.cancelSchedule,
      })
      client.subscribeAll(() => {})

      const first = FakeWebSocket.instances[0]
      first.simulateOpen()
      first.simulateMessage(eventFrame('r-1', 40, 'run.created'))
      first.simulateDrop()
      scheduler.fireNext()

      const second = FakeWebSocket.instances[1]
      second.simulateOpen()
      expect(second.sent).toEqual([JSON.stringify({ op: 'subscribe_all', from_seq: 0 })])
    })

    it('unsubscribe() does not reconnect', () => {
      const webSocketCtor = freshFakeWebSocketCtor()
      const scheduler = queuedScheduler()
      const client = createDaemonClient({
        baseUrl: 'http://localhost:4000',
        token: 'tok',
        webSocketCtor,
        schedule: scheduler.schedule,
        cancelSchedule: scheduler.cancelSchedule,
      })
      const subscription = client.subscribeAll(() => {})
      FakeWebSocket.instances[0].simulateOpen()
      subscription.unsubscribe()
      expect(scheduler.pending()).toBe(0)
    })
  })
})
