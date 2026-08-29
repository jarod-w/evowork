// ---------------------------------------------------------------------------
// TEMPORARY, HAND-WRITTEN PROTOCOL TYPES.
//
// This file is a stopgap. The real contract lives in the Rust side of the
// daemon; a later stage generates the equivalent TS types from Rust with
// `ts-rs` into `packages/protocol`, and this file is deleted once that
// package exists (design doc 06-protocol.md: "契约层是 packages/protocol，
// TS 类型从 Rust 侧用 ts-rs 生成，不手写两遍"). Until then, this hand-picks
// the minimal slice of the wire format that `daemon/client.ts` needs.
//
// Do not grow this file into a full protocol surface -- it only exists to
// unblock the client before packages/protocol is real.
// ---------------------------------------------------------------------------

/**
 * A parsed `protocol_ver` (e.g. `"1.3"` -> `{ major: 1, minor: 3 }`).
 *
 * Version negotiation (design doc 06 §5, Q-23) only ever compares these two
 * numbers -- `daemon_ver` and `runlog_schema_ver` are informational.
 */
export interface ProtocolVersion {
  major: number
  minor: number
}

/**
 * The greeting frame the daemon reports first. Fetched over `GET
 * /v1/hello` in this stage (the WS channel carries only event/subscribe
 * traffic -- see design doc 06 §2). Field names match the wire format
 * verbatim, including the snake_case, so no renaming layer is needed once
 * this is replaced by a generated type.
 */
export interface HelloFrame {
  op: 'hello'
  protocol_ver: string
  daemon_ver: string
  runlog_schema_ver: number
}

/**
 * `POST /v1/rpc` request body (design doc 06 §3).
 */
export interface RpcRequest<TParams = unknown> {
  id: number
  method: string
  params: TParams
}

export interface RpcErrorBody {
  code: number
  message: string
}

/**
 * `POST /v1/rpc` response body. Exactly one of `result` / `error` is
 * present, but the wire format doesn't encode that as a discriminated
 * union (the daemon can't guarantee a `success` tag is stamped for every
 * error path yet), so callers must check `error` first.
 */
export interface RpcResponse<TResult = unknown> {
  id: number
  result?: TResult
  error?: RpcErrorBody
}

/**
 * Client -> server frame on the events WebSocket: subscribe to one run's
 * log from a given seq (design doc 06 §2). `from_seq` is what makes
 * reconnect lossless: the client remembers the last seq it saw and
 * re-subscribes from there instead of polling or replaying from zero.
 */
export interface SubscribeFrame {
  op: 'subscribe'
  run_id: string
  from_seq: number
}

/**
 * Server -> client frame carrying one Run Log event. Deliberately *not*
 * a closed set of known `kind`s: design doc 06 §2 is explicit that the
 * event body must match the Run Log's own definition field-for-field, so
 * this type stays open (`Record<string, unknown>`-shaped tail) rather
 * than re-declaring every event schema by hand.
 */
export interface EventFrame {
  op: 'event'
  run_id: string
  seq: number
  kind: string
  [key: string]: unknown
}

/**
 * Server -> client frame marking the end of backlog replay for a
 * subscription: everything from here on is delivered live.
 */
export interface CaughtUpFrame {
  op: 'caught_up'
  run_id: string
  at_seq: number
}

/** Any frame the server can push down the events WebSocket. */
export type ServerStreamFrame = EventFrame | CaughtUpFrame
