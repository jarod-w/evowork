import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Event, EventBody, HelloFrame, ServerStreamFrame } from '@evowork/protocol'

import App from './App'
import type { DaemonClient, DaemonClientStatus, DaemonSubscription } from './daemon/client'
import { DAEMON_SETTINGS_STORAGE_KEY } from './daemon/config'
import type { DaemonSettingsStorage } from './daemon/config'
import type { Platform, PlatformInfo } from './platform'
import { render } from './workspace/renderTest'

/**
 * Types into a React-controlled input.
 *
 * Assigning `input.value` directly is not enough: React tracks the last
 * value it rendered on the DOM node, sees no change, and drops the
 * synthetic `change`/`input` event -- so the component's `onChange` never
 * runs and the test asserts against state the user could not have
 * produced. Going through the prototype's native setter updates the node
 * *and* invalidates React's tracker, which is what makes the dispatched
 * event land.
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTMLInputElement.prototype has no value setter')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const hello: HelloFrame = {
  op: 'hello',
  protocol_ver: '1.0',
  daemon_ver: '0.1.0-test',
  runlog_schema_ver: 1,
}

function event(runId: string, seq: number, body: EventBody): Event {
  return {
    run_id: runId,
    seq,
    recorded_at: `2026-08-31T00:00:${String(seq).padStart(2, '0')}Z`,
    actor: 'runtime',
    schema_ver: 1,
    body,
  }
}

function stubClient(options?: { onRpc?: (method: string, params: unknown) => Promise<unknown> }): {
  client: DaemonClient
  push: (frame: ServerStreamFrame) => void
} {
  let listener: ((frame: ServerStreamFrame) => void) | null = null
  const status: DaemonClientStatus = {
    connected: true,
    readOnly: false,
    protocolVersion: { major: 1, minor: 0 },
  }
  const client: DaemonClient = {
    hello: () => Promise.resolve(hello),
    rpc: <TParams, TResult>(method: string, params: TParams) =>
      (options?.onRpc?.(method, params) ?? Promise.resolve({})) as Promise<TResult>,
    subscribe: () => ({ unsubscribe() {} }),
    subscribeAll: (onEvent) => {
      listener = onEvent
      const sub: DaemonSubscription = { unsubscribe() {} }
      return sub
    },
    getStatus: () => ({ ...status }),
  }
  return {
    client,
    push: (frame) => listener?.(frame),
  }
}

describe('App workspace', () => {
  it('projects two pending approvals into Inbox and the run pane, and does not call unknown 无影响', async () => {
    const { client, push } = stubClient()
    const { host, unmount } = render(<App client={client} />)

    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push({
        op: 'event',
        event: event('r-9', 0, {
          kind: 'run.created',
          run_id: 'r-9',
          workspace_id: 'w',
          principal: { kind: 'user', id: 'p' },
          trigger: { kind: 'manual', reference: 'ui' },
          budget: {},
          labels: {},
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 1, {
          kind: 'tool.requested',
          effect_id: 'e-1',
          turn: 1,
          tool: 'shell.exec',
          params_ref: { content_hash: 'sha256:p', size: 1, mime: 'application/json' },
          params_digest: 'd',
          class: 'external',
          declared_targets: [],
          declared_egress: [],
          reversible: false,
          cites_referenced: [],
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 2, {
          kind: 'impact.estimated',
          effect_id: 'e-1',
          targets: [],
          externals: [],
          precision: 'unknown',
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 3, {
          kind: 'approval.requested',
          approval_id: 'a-1',
          effect_id: 'e-1',
          risk: 'l3',
          expires_at_ms: 4_000_000_000_000,
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 4, {
          kind: 'approval.requested',
          approval_id: 'a-2',
          effect_id: 'e-2',
          risk: 'l2',
          expires_at_ms: 4_000_000_000_000,
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 5, {
          kind: 'cost.charged',
          unit: 'call',
          quantity: 1,
          unit_price_micros: 2_000_000,
          amount_micros: 2_000_000,
          currency: 'CNY',
          price_table_ver: '1',
          dimension: { principal: 'p', run_id: 'r-9', tool: 'shell.exec' },
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 6, {
          kind: 'artifact.emitted',
          artifact_id: 'art-1',
          path: 'report.txt',
          blob: { content_hash: 'sha256:art', size: 4, mime: 'text/plain' },
          cites: [],
        }),
      })
    })

    const inboxCards = host.querySelectorAll('[data-testid="inbox"] [data-testid="approval-card"]')
    expect(inboxCards.length).toBe(2)
    const runCards = host.querySelectorAll('[data-testid="run-approvals"] [data-testid="approval-card"]')
    expect(runCards.length).toBe(2)

    const unknownCopy = [...host.querySelectorAll('[data-testid="impact-copy"]')].find(
      (node) => node.getAttribute('data-impact-tone') === 'unknown',
    )
    expect(unknownCopy?.textContent).toContain('影响未知')
    expect(unknownCopy?.textContent).not.toMatch(/无影响/)
    expect(unknownCopy?.textContent).not.toMatch(/沙箱工作区/)

    expect(host.querySelector('[data-testid="cost-total"]')?.textContent).toContain('2.00')
    expect(host.querySelector('[data-testid="artifacts"]')?.textContent).toContain('report.txt')
    expect(host.querySelector('[data-testid="timeline"]')?.textContent).toContain('请求审批')

    unmount()
  })

  it('sends budget.amend through daemonClient.rpc when the exhausted-budget card is submitted', async () => {
    const rpc = vi.fn().mockResolvedValue({})
    const { client, push } = stubClient({ onRpc: rpc })
    const { host, unmount } = render(<App client={client} />)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push({
        op: 'event',
        event: event('r-b', 0, {
          kind: 'run.created',
          run_id: 'r-b',
          workspace_id: 'w',
          principal: { kind: 'user', id: 'p' },
          trigger: { kind: 'manual', reference: 'ui' },
          budget: { max_amount_micros: 300 },
          labels: {},
        }),
      })
      push({
        op: 'event',
        event: event('r-b', 1, {
          kind: 'cost.charged',
          unit: 'call',
          quantity: 1,
          unit_price_micros: 400,
          amount_micros: 400,
          currency: 'CNY',
          price_table_ver: '1',
          dimension: { principal: 'p', run_id: 'r-b' },
        }),
      })
      push({
        op: 'event',
        event: event('r-b', 2, {
          kind: 'run.suspended',
          reason: 'budget_exhausted',
        }),
      })
    })

    const cards = host.querySelectorAll('[data-testid="budget-card"]')
    expect(cards.length).toBeGreaterThanOrEqual(1)
    expect(host.querySelector('[data-testid="inbox"] [data-testid="budget-card"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="run-budget"] [data-testid="budget-card"]')).toBeTruthy()

    const button = [...host.querySelectorAll('button')].find((el) => el.textContent === '提额并续跑')
    expect(button).toBeTruthy()
    await act(async () => {
      button?.click()
    })
    expect(rpc).toHaveBeenCalledWith(
      'budget.amend',
      expect.objectContaining({
        run_id: 'r-b',
        budget: expect.objectContaining({ max_amount_micros: expect.any(Number) }),
      }),
    )
    const sent = rpc.mock.calls.find((call) => call[0] === 'budget.amend')?.[1] as {
      budget: { max_amount_micros: number }
    }
    expect(sent.budget.max_amount_micros).toBeGreaterThan(400)
    unmount()
  })

  it('shows checkpoint count on the timeline instead of leaving the audit view empty', async () => {
    const { client, push } = stubClient()
    const { host, unmount } = render(<App client={client} />)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push({
        op: 'event',
        event: event('r-a', 0, {
          kind: 'run.created',
          run_id: 'r-a',
          workspace_id: 'w',
          principal: { kind: 'user', id: 'p' },
          trigger: { kind: 'manual', reference: 'ui' },
          budget: {},
          labels: {},
        }),
      })
      push({
        op: 'event',
        event: event('r-a', 1, {
          kind: 'checkpoint',
          checkpoint_id: 'r-a-cp1',
          state_hash: 'deadbeefcafebabe',
          reason: 'pre_approval',
        }),
      })
      push({
        op: 'event',
        event: event('r-a', 2, {
          kind: 'approval.denied',
          approval_id: 'a-1',
          by: { human: 'p' },
        }),
      })
    })

    expect(host.querySelector('[data-testid="audit-summary"]')?.textContent).toContain('1 个检查点')
    expect(host.querySelector('[data-testid="timeline"]')?.textContent).toContain('检查点')

    const checkpointTab = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="timeline-filter"] button')].find(
      (el) => el.textContent === '检查点',
    )
    expect(checkpointTab).toBeTruthy()
    await act(async () => {
      checkpointTab?.click()
    })
    const kinds = [...host.querySelectorAll('[data-testid="timeline"] li')].map((li) => li.getAttribute('data-kind'))
    expect(kinds).toEqual(['checkpoint'])
    unmount()
  })

  it('sends clarification.answer through daemonClient.rpc, not a local state patch', async () => {
    const rpc = vi.fn().mockResolvedValue({})
    const { client, push } = stubClient({ onRpc: rpc })
    const { host, unmount } = render(<App client={client} />)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push({
        op: 'event',
        event: event('r-3', 0, {
          kind: 'clarification.requested',
          question_id: 'q-1',
          prompt_ref: { content_hash: 'sha256:q', size: 2, mime: 'application/json' },
          options: [{ id: 'yes', is_default: true }],
        }),
      })
    })

    const button = [...host.querySelectorAll('button')].find((el) => el.textContent === '回答')
    expect(button).toBeTruthy()
    await act(async () => {
      button?.click()
    })
    expect(rpc).toHaveBeenCalledWith(
      'clarification.answer',
      expect.objectContaining({ run_id: 'r-3', question_id: 'q-1', option_id: 'yes' }),
    )
    unmount()
  })
})

// ---------------------------------------------------------------------------
// P0-17: the packaged desktop artifact could not reach a daemon, and the UI
// offered no way to fix that after install.
//
// Two independent defects, both reproduced below before the fix and both
// asserted here:
//
//   1. `App` baked `import.meta.env.VITE_DAEMON_TOKEN ?? ''` in at BUILD
//      time. A bundle built without that variable shipped an empty token,
//      and `evo-daemon` answers `401` to an empty bearer (measured
//      2026-09-01: `Authorization: Bearer ` -> 401, correct token -> 200).
//   2. There was no settings entry anywhere in the UI, so an installed
//      `.app` with the wrong settings was unfixable -- the window stayed
//      empty forever.
//
// These tests drive `App` through the `Platform`/storage seams rather than
// through Tauri's JS binding packages, which CI-9 forbids importing outside
// `platform/`. See `AppProps.platform` for why that seam exists.
// ---------------------------------------------------------------------------

function memoryStorage(initial?: string): DaemonSettingsStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  if (initial !== undefined) items.set(DAEMON_SETTINGS_STORAGE_KEY, initial)
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

/**
 * A `Platform` whose only interesting method is `readClientToml`. The
 * other five throw: nothing in these tests should reach them, and a
 * throw says so loudly instead of returning a plausible-looking value.
 */
function fakePlatform(options: {
  kind: 'browser' | 'desktop'
  clientToml?: string | null
}): Platform & { info: PlatformInfo } {
  const canRead = options.kind === 'desktop'
  const nope = (name: string) => () => Promise.reject(new Error(`fakePlatform.${name}() not expected`))
  return {
    pickFile: nope('pickFile') as () => Promise<File | null>,
    openExternal: nope('openExternal'),
    notify: nope('notify'),
    setAutoLaunch: nope('setAutoLaunch'),
    quit: nope('quit'),
    readClientToml: () =>
      canRead
        ? Promise.resolve(options.clientToml ?? null)
        : Promise.reject(new Error('platform.readClientToml() is not supported in the browser shell')),
    info: {
      kind: options.kind,
      supports: (cap) => (cap === 'readClientToml' ? canRead : true),
    },
  }
}

/** A client that always fails `hello()`, i.e. an unreachable daemon. */
function unreachableClient(message: string): DaemonClient {
  return {
    hello: () => Promise.reject(new Error(message)),
    rpc: () => Promise.reject(new Error(message)),
    subscribe: () => ({ unsubscribe() {} }),
    subscribeAll: () => ({ unsubscribe() {} }),
    getStatus: () => ({ connected: false, readOnly: false, protocolVersion: null }),
  }
}

/** A client that connects, so `App` treats the settings as good. */
function connectedClient(): DaemonClient {
  return {
    hello: () => Promise.resolve(hello),
    // Cast, not `{}`: `rpc` is generic in its result, and no concrete
    // value satisfies an arbitrary `TResult`. Nothing in these tests reads
    // an rpc result -- they assert on which client got built, not on what
    // it returned.
    rpc: <_TParams, TResult>() => Promise.resolve({} as TResult),
    subscribe: () => ({ unsubscribe() {} }),
    subscribeAll: () => ({ unsubscribe() {} }),
    getStatus: () => ({ connected: true, readOnly: false, protocolVersion: { major: 1, minor: 0 } }),
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('daemon connection settings (P0-17)', () => {
  it('shows the settings panel, unprompted, when the daemon cannot be reached', async () => {
    const { host, unmount } = render(
      <App
        client={unreachableClient('Load failed')}
        storage={memoryStorage()}
        platform={fakePlatform({ kind: 'browser' })}
      />,
    )
    await settle()

    // The panel must be there without the user having to find it: an
    // installed artifact whose settings are wrong is otherwise a dead end.
    const panel = host.querySelector('[data-testid="daemon-settings"]')
    expect(panel).toBeTruthy()
    expect(host.querySelector('[data-testid="daemon-settings-url"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="daemon-settings-token"]')).toBeTruthy()
    // And it reports the failure, rather than leaving "not connected" as
    // the only clue.
    expect(host.querySelector('[data-testid="daemon-settings-error"]')?.textContent).toContain('Load failed')

    unmount()
  })

  it('names the source of the settings in use, and warns when the token is the empty default', async () => {
    const { host, unmount } = render(
      <App
        client={unreachableClient('HTTP 401')}
        storage={memoryStorage()}
        platform={fakePlatform({ kind: 'browser' })}
      />,
    )
    await settle()

    // Nothing saved, no VITE_* vars under vitest, no readable client.toml
    // in a browser shell -- so this is exactly the packaged-.app state,
    // and the panel has to say the token is empty rather than just
    // reporting "not connected".
    const source = host.querySelector('[data-testid="daemon-settings-source"]')?.textContent ?? ''
    expect(source).toContain('内置默认值')
    expect(source).toContain('401')

    unmount()
  })

  it('reconnects with the settings the user saved, and persists them', async () => {
    const storage = memoryStorage()
    const built: Array<{ baseUrl: string; token: string }> = []
    const createClient = (config: { baseUrl: string; token: string }) => {
      built.push(config)
      // First attempt (the empty-token default) fails; the settings the
      // user types then succeed. That ordering is the fix working.
      return config.token === 'real-token' ? connectedClient() : unreachableClient('HTTP 401')
    }

    const { host, unmount } = render(
      <App
        createClient={createClient}
        storage={storage}
        platform={fakePlatform({ kind: 'browser' })}
      />,
    )
    await settle()

    expect(built).toEqual([{ baseUrl: 'http://127.0.0.1:4477', token: '' }])

    const url = host.querySelector<HTMLInputElement>('[data-testid="daemon-settings-url"]')!
    const token = host.querySelector<HTMLInputElement>('[data-testid="daemon-settings-token"]')!
    const save = host.querySelector<HTMLButtonElement>('[data-testid="daemon-settings-save"]')!

    await act(async () => {
      setInputValue(url, 'http://127.0.0.1:5599')
      setInputValue(token, 'real-token')
    })
    await act(async () => {
      save.click()
    })
    await settle()

    // A new client was built from the typed settings -- not the baked ones.
    expect(built).toEqual([
      { baseUrl: 'http://127.0.0.1:4477', token: '' },
      { baseUrl: 'http://127.0.0.1:5599', token: 'real-token' },
    ])
    // Persisted, so a reload does not send the user back to square one.
    expect(JSON.parse(storage.items.get(DAEMON_SETTINGS_STORAGE_KEY)!)).toEqual({
      baseUrl: 'http://127.0.0.1:5599',
      token: 'real-token',
    })
    // Connected now, so the panel collapses on its own.
    expect(host.querySelector('[data-testid="daemon-settings"]')).toBeNull()

    unmount()
  })

  it('picks the token up from client.toml on desktop with no user action at all', async () => {
    const built: Array<{ baseUrl: string; token: string }> = []
    const createClient = (config: { baseUrl: string; token: string }) => {
      built.push(config)
      return config.token === 'from-toml' ? connectedClient() : unreachableClient('HTTP 401')
    }

    const { host, unmount } = render(
      <App
        createClient={createClient}
        storage={memoryStorage()}
        platform={fakePlatform({
          kind: 'desktop',
          // Byte-for-byte what evo-daemon writes on first run.
          clientToml: 'token = "from-toml"\nurl = "http://127.0.0.1:4477"\n',
        })}
      />,
    )
    await settle()

    // The whole point of the zero-config path: the very FIRST client is
    // built with the daemon's own token. Nobody typed anything.
    expect(built).toEqual([{ baseUrl: 'http://127.0.0.1:4477', token: 'from-toml' }])
    expect(host.querySelector('[data-testid="daemon-settings"]')).toBeNull()

    unmount()
  })

  it('lets saved settings override client.toml, and restores client.toml when they are cleared', async () => {
    const storage = memoryStorage(
      JSON.stringify({ baseUrl: 'http://elsewhere:9000', token: 'saved-token' }),
    )
    const built: Array<{ baseUrl: string; token: string }> = []
    const createClient = (config: { baseUrl: string; token: string }) => {
      built.push(config)
      return unreachableClient('HTTP 401')
    }

    const { host, unmount } = render(
      <App
        createClient={createClient}
        storage={storage}
        platform={fakePlatform({
          kind: 'desktop',
          clientToml: 'token = "from-toml"\nurl = "http://127.0.0.1:4477"\n',
        })}
      />,
    )
    await settle()

    // Saved wins: someone who typed a token is usually pointing at a
    // different daemon than the local one that wrote client.toml.
    expect(built[0]).toEqual({ baseUrl: 'http://elsewhere:9000', token: 'saved-token' })

    const clear = host.querySelector<HTMLButtonElement>('[data-testid="daemon-settings-clear"]')
    expect(clear).toBeTruthy()
    await act(async () => {
      clear!.click()
    })
    await settle()

    // Clearing lands on whatever would have been used had nothing ever
    // been saved -- here, client.toml.
    expect(built[1]).toEqual({ baseUrl: 'http://127.0.0.1:4477', token: 'from-toml' })
    expect(storage.items.has(DAEMON_SETTINGS_STORAGE_KEY)).toBe(false)

    unmount()
  })

  it('offers no client.toml fill in the browser shell, and says why', async () => {
    const { host, unmount } = render(
      <App
        client={unreachableClient('Load failed')}
        storage={memoryStorage()}
        platform={fakePlatform({ kind: 'browser' })}
      />,
    )
    await settle()

    expect(host.querySelector('[data-testid="daemon-settings-fill"]')).toBeNull()
    expect(host.querySelector('[data-testid="daemon-settings"]')?.textContent).toContain('浏览器里读不了')

    unmount()
  })

  it('reconnects on 重连 even when the settings did not change', async () => {
    let attempts = 0
    const createClient = () => {
      attempts += 1
      return unreachableClient('Load failed')
    }

    const { host, unmount } = render(
      <App createClient={createClient} storage={memoryStorage()} platform={fakePlatform({ kind: 'browser' })} />,
    )
    await settle()
    expect(attempts).toBe(1)

    // Nothing edited: the button reads 重连, and it has to actually
    // reconnect. A memoised client keyed only on the settings would hand
    // back the same instance and do nothing at all.
    const save = host.querySelector<HTMLButtonElement>('[data-testid="daemon-settings-save"]')!
    expect(save.textContent).toBe('重连')
    await act(async () => {
      save.click()
    })
    await settle()

    expect(attempts).toBe(2)

    unmount()
  })

  it('keeps the settings panel reachable while connected, through the header button', async () => {
    const { host, unmount } = render(
      <App client={connectedClient()} storage={memoryStorage()} platform={fakePlatform({ kind: 'browser' })} />,
    )
    await settle()

    expect(host.querySelector('[data-testid="daemon-settings"]')).toBeNull()

    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="settings-toggle"]')!
    await act(async () => {
      toggle.click()
    })

    expect(host.querySelector('[data-testid="daemon-settings"]')).toBeTruthy()

    unmount()
  })
})
