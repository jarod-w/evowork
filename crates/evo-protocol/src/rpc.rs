//! daemon ↔ UI 协议类型（设计文档 06）。
//!
//! 事件体本身就是 [`crate::Event`]——UI 收到的是 Log 里存的，不做另一套 DTO
//! （06 §2）。本模块只放两条通道上**额外**的帧：hello、JSON-RPC 信封、
//! 订阅指令、`caught_up`，以及 RPC 方法的 params/result。

use crate::effect::EffectClass;
use crate::events::accounting::Currency;
use crate::events::effect::ExecutionMode;
use crate::ids::{ApprovalId, RunId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 当前协议主.次版本。bump 主版本必须与 UI 的 `CLIENT_PROTOCOL_VERSION` 同步。
pub const PROTOCOL_VER: &str = "1.0";

/// Run Log 事件 schema 的全局版本。事件级 `schema_ver` 才是逐变体的。
pub const RUNLOG_SCHEMA_VER: u32 = 1;

/// 问候帧（06 §5）。HTTP `GET /v1/hello` 与 WS 连接后的第一条消息共用。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct HelloFrame {
    pub op: HelloOp,
    pub protocol_ver: String,
    pub daemon_ver: String,
    pub runlog_schema_ver: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum HelloOp {
    Hello,
}

impl HelloFrame {
    pub fn new(daemon_ver: impl Into<String>) -> Self {
        Self {
            op: HelloOp::Hello,
            protocol_ver: PROTOCOL_VER.to_owned(),
            daemon_ver: daemon_ver.into(),
            runlog_schema_ver: RUNLOG_SCHEMA_VER,
        }
    }
}

/// `POST /v1/rpc` 请求信封（06 §3）。`params` 的形状由 `method` 决定，
/// 这里保持 `unknown`——强类型的 params 结构体在下面，由 daemon 按 method 解码。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcRequest {
    pub id: u32,
    pub method: String,
    #[ts(type = "unknown")]
    pub params: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RpcErrorBody {
    pub code: i64,
    pub message: String,
}

/// `POST /v1/rpc` 响应信封。恰好一个 `result` / `error` 出现。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcResponse {
    pub id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown", optional)]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcErrorBody>,
}

impl RpcResponse {
    pub fn ok(id: u32, result: serde_json::Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u32, code: i64, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcErrorBody {
                code,
                message: message.into(),
            }),
        }
    }
}

/// JSON-RPC 风格错误码。未实现的方法与未知方法共用 -32601，
/// 让「协议里有、daemon 还没接线」和「根本没这个方法」在 UI 上看起来一样——
/// 都是「现在做不了」，而不是假装成功。
pub const RPC_METHOD_NOT_FOUND: i64 = -32601;
pub const RPC_INVALID_PARAMS: i64 = -32602;
pub const RPC_INTERNAL: i64 = -32603;
pub const RPC_NOT_FOUND: i64 = -32004;

// ---------------------------------------------------------------------------
// 事件流帧（06 §2）
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SubscribeOp {
    Subscribe,
}

/// 客户端 → 服务端：订阅一条 run 的 Log，从 `from_seq` 续订。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SubscribeFrame {
    pub op: SubscribeOp,
    pub run_id: RunId,
    pub from_seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SubscribeAllOp {
    SubscribeAll,
}

/// 客户端 → 服务端：订阅全部 run。`from_seq` 按每条 run 各自应用。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SubscribeAllFrame {
    pub op: SubscribeAllOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_seq: Option<u64>,
}

/// 客户端在事件 WS 上能发的帧。用 internally tagged `op` 解码。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClientStreamFrame {
    Subscribe {
        run_id: RunId,
        from_seq: u64,
    },
    SubscribeAll {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_seq: Option<u64>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum EventFrameOp {
    Event,
}

/// 服务端 → 客户端：一条 Run Log 事件。`event` 就是 Log 行，字段与
/// [`crate::Event`] 逐字段一致——不另做 DTO（06 §2）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct EventFrame {
    pub op: EventFrameOp,
    pub event: crate::Event,
}

impl EventFrame {
    pub fn new(event: crate::Event) -> Self {
        Self {
            op: EventFrameOp::Event,
            event,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CaughtUpOp {
    CaughtUp,
}

/// 服务端 → 客户端：积压回放结束，此后是实时推送。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaughtUpFrame {
    pub op: CaughtUpOp,
    pub run_id: RunId,
    pub at_seq: u64,
}

impl CaughtUpFrame {
    pub fn new(run_id: RunId, at_seq: u64) -> Self {
        Self {
            op: CaughtUpOp::CaughtUp,
            run_id,
            at_seq,
        }
    }
}

/// 服务端在事件 WS 上能推的帧（不含 hello——hello 是连接后单独的第一条）。
///
/// `Event` 远大于 `CaughtUp`，但这两个变体就是线格式，不能为了 clippy
/// 把 `event` 改成 `Box`——生成的 TS 与 JSON 都要保持「字段就是 Event」。
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ServerStreamFrame {
    Event { event: crate::Event },
    CaughtUp { run_id: RunId, at_seq: u64 },
}

// ---------------------------------------------------------------------------
// RPC 方法 params / result（06 §3）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RunCreateParams {
    pub intent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ExecutionMode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RunCreateResult {
    pub run_id: RunId,
    pub status: String,
    pub last_seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RunIdParams {
    pub run_id: RunId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RunGetResult {
    pub run_id: RunId,
    pub status: String,
    pub turn: u32,
    pub last_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaiting: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RunListResult {
    pub runs: Vec<RunGetResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RunEventsParams {
    pub run_id: RunId,
    #[serde(default)]
    pub from_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RunEventsResult {
    pub events: Vec<crate::Event>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ApprovalDecideParams {
    pub run_id: RunId,
    pub approval_id: ApprovalId,
    pub granted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ClarificationAnswerParams {
    pub run_id: RunId,
    pub question_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CostQueryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CostQueryResult {
    pub amount_micros: u64,
    pub currency: Currency,
    pub entries: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToolListItem {
    pub name: String,
    pub class: EffectClass,
    pub reversible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToolListResult {
    pub tools: Vec<ToolListItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToolManifestParams {
    pub tool: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToolManifestResult {
    pub name: String,
    pub class: EffectClass,
    pub reversible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PolicyGetResult {
    pub policy_toml: String,
}

/// 按 content hash 取回 blob 正文。事件 payload 里只有 [`crate::BlobRef`]，
/// 澄清选项文案、意图原文、产物内容都在 blob store 里——UI 是 Log 的投影，
/// 要渲染这些就得有一条只读的取回通道，不能把正文再拷进事件（红线①）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BlobGetParams {
    pub content_hash: String,
}

/// UTF-8 文本。当前所有产生方（intent / 澄清 prompt JSON / `fs.write`）
/// 都是文本；非 UTF-8 由 daemon 以错误返回，不在这里发明一种二进制包装。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BlobGetResult {
    pub content_hash: String,
    pub size: u64,
    pub text: String,
}

/// 06 §3 列出的全部方法。实现方按这个清单接线；未接线的返回
/// [`RPC_METHOD_NOT_FOUND`]。
pub const RPC_METHODS: &[&str] = &[
    "run.create",
    "run.cancel",
    "run.pause",
    "run.resume",
    "run.fork",
    "run.list",
    "run.get",
    "run.events",
    "approval.decide",
    "clarification.answer",
    "artifact.list",
    "artifact.download",
    "blob.get",
    "cost.query",
    "trigger.create",
    "trigger.list",
    "trigger.delete",
    "trigger.dryrun",
    "tool.list",
    "tool.manifest",
    "policy.get",
    "eval.run",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_frame_wire_shape_matches_doc_06() {
        let frame = HelloFrame::new("0.1.0");
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["op"], "hello");
        assert_eq!(v["protocol_ver"], "1.0");
        assert_eq!(v["daemon_ver"], "0.1.0");
        assert_eq!(v["runlog_schema_ver"], 1);
    }

    #[test]
    fn subscribe_frame_uses_the_op_tag_from_doc_06() {
        let frame = ClientStreamFrame::Subscribe {
            run_id: RunId::from("r-1"),
            from_seq: 0,
        };
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["op"], "subscribe");
        assert_eq!(v["run_id"], "r-1");
        assert_eq!(v["from_seq"], 0);
    }
}
