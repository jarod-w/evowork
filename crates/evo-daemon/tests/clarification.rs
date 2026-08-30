//! M2 Task 6：A-12「澄清式追问（带默认选项，一键回答）」端到端。
//!
//! 前面几个任务已经铺好了骨架（`clarification.requested`/`answered` 事件、
//! 内核挂起/恢复、`clarification.answered` 把 `context_turn`/`plan_turn`
//! 一并回退让 `decide` 重新走 `AssembleContext → CallModel`）。这个文件
//! 补的是最后一段、也是本任务的要害：证明**答案真的进了重新装配的
//! 上下文**，而不只是「事件出现了、状态字段清空了」——`evo-kernel` 的
//! `reduce.rs` 在 `ClarificationAnswered` 分支上明确把这一步的责任交接给
//! 装配器，交接不落实，A-12 就是"形式上不空转、内容上空转"。

use evo_daemon::{DaemonConfig, FixedClock, RunOutcome, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::{AwaitReason, RunStatus};
use evo_model::FixtureAdapter;
use evo_protocol::events::context::ContextAssembled;
use evo_protocol::{Actor, BlobRef, EventBody, RunId};
use evo_runlog::RunLog;
use std::sync::Arc;

/// 第一轮：模型直接给出一个带默认选项的澄清问题——问题正文与全部选项
/// 文案都只活在这段 JSON 里，`parse_plan` 负责把它们从模型原始响应中
/// 解出来，runtime 再把它们落进 blob（绝不进任何事件 payload）。
/// 第二轮：回答之后模型说结束。
const CLARIFY_WITH_OPTIONS_FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"clarify\",\"question\":\"是否对某某公司的12万逾期发起催收？\",\"options\":[{\"id\":\"opt-yes\",\"label\":\"是，立即发起催收\",\"is_default\":true},{\"id\":\"opt-no\",\"label\":\"否，再等等\",\"is_default\":false}]}",
      "usage": { "input": 20, "output": 12, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 1 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 30, "output": 6, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 1 }
  ]
}"#;

const ALLOW_ALL_POLICY: &str = r#"
version = "poc-1"
"#;

const INTENT_TEXT: &str = "这笔逾期要不要发起催收？";
const FREE_TEXT_ANSWER: &str = "客户已承诺下周三还款，先别催";

fn setup(dir: &std::path::Path, fixtures: &str) -> Runtime {
    let mut config = DaemonConfig::for_test(dir);
    config.policy_toml = ALLOW_ALL_POLICY.to_owned();
    Runtime::new(
        config,
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(fixtures).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap()
}

fn open_log(dir: &std::path::Path) -> RunLog {
    RunLog::open(&dir.join("runlog.sqlite"), &dir.join("blobs")).unwrap()
}

fn event_kinds(log: &RunLog, run_id: &RunId) -> Vec<&'static str> {
    log.events(run_id, 0, None)
        .unwrap()
        .iter()
        .map(|e| e.body.kind())
        .collect()
}

/// 用一个假的 size/mime 拼一份能查到内容的 `BlobRef`——`BlobStore::get`
/// 只按 `content_hash` 定位文件，size/mime 不参与寻址。
fn blob_text(log: &RunLog, content_hash: &str) -> String {
    let r = BlobRef {
        content_hash: content_hash.to_owned(),
        size: 0,
        mime: "text/plain".to_owned(),
    };
    String::from_utf8(log.blobs().get(&r).unwrap()).unwrap()
}

fn context_assembled_events(log: &RunLog, run_id: &RunId) -> Vec<ContextAssembled> {
    log.events(run_id, 0, None)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e.body {
            EventBody::ContextAssembled(c) => Some(c),
            _ => None,
        })
        .collect()
}

// ————————————————————————————————————————————————————————————
// 1. 挂起在 clarification.requested + run.suspended，start 返回 Suspended。
// 4. 带默认选项：options 里 is_default 的那一项能被识别（一键回答的前提）。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn clarification_with_a_default_option_suspends_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path(), CLARIFY_WITH_OPTIONS_FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt
        .start(&run_id, INTENT_TEXT)
        .await
        .expect("挂起路径上不该有任何 Err");
    let RunOutcome::Suspended { state, reason } = outcome else {
        panic!("expected Suspended, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Suspended);
    assert!(
        matches!(reason, AwaitReason::Clarification { .. }),
        "挂起原因应该是 Clarification，实得 {reason:?}"
    );

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(kinds.contains(&"clarification.requested"));
    assert_eq!(kinds.last(), Some(&"run.suspended"));

    // 带默认选项：options 里能找到唯一一个 is_default == true 的项，
    // 且 id 与 fixture 给出的 opt-yes 对上——一键回答就是直接拿这个 id
    // 去调 answer_clarification，不需要用户先看清楚每个选项。
    let requested = log
        .events(&run_id, 0, None)
        .unwrap()
        .into_iter()
        .find_map(|e| match e.body {
            EventBody::ClarificationRequested(c) => Some(c),
            _ => None,
        })
        .expect("应该有一条 clarification.requested");
    let defaults: Vec<_> = requested.options.iter().filter(|o| o.is_default).collect();
    assert_eq!(
        defaults.len(),
        1,
        "应该有且只有一个默认选项：{:?}",
        requested.options
    );
    assert_eq!(defaults[0].id, "opt-yes");
    assert!(
        requested
            .options
            .iter()
            .any(|o| o.id == "opt-no" && !o.is_default),
        "非默认选项应该保留、且 is_default 为 false：{:?}",
        requested.options
    );
}

// ————————————————————————————————————————————————————————————
// 2. answer_clarification 之后追加 clarification.answered + run.resumed，
//    run 跑到 run.completed。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn answering_appends_the_answer_and_the_run_completes() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path(), CLARIFY_WITH_OPTIONS_FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt.start(&run_id, INTENT_TEXT).await.unwrap();
    let RunOutcome::Suspended { reason, .. } = outcome else {
        panic!("expected Suspended, got {outcome:?}");
    };
    let AwaitReason::Clarification { question_id } = reason else {
        panic!("expected AwaitReason::Clarification, got {reason:?}");
    };

    let outcome = rt
        .answer_clarification(
            &run_id,
            &question_id,
            Some("opt-no"),
            Some(FREE_TEXT_ANSWER),
            Actor::Human("u-1".into()),
        )
        .await
        .expect("回答澄清、驱动到底，全程不该有 Err");
    let RunOutcome::Completed(state) = outcome else {
        panic!("expected Completed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Completed);

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(kinds.contains(&"clarification.answered"));
    assert!(kinds.contains(&"run.resumed"));
    assert_eq!(kinds.last(), Some(&"run.completed"));
}

// ————————————————————————————————————————————————————————————
// 3. 核心：答案真的影响了后续——回答之后装配进上下文的内容含那个答案。
//    只验状态字段清空、事件出现，抓不住"内核不再空转但装配器仍然
//    空转"这种坏法（Task 3 报告里记录的教训）；这里断言到 blob 内容。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn the_answer_actually_lands_in_the_reassembled_context() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path(), CLARIFY_WITH_OPTIONS_FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt.start(&run_id, INTENT_TEXT).await.unwrap();
    let RunOutcome::Suspended { reason, .. } = outcome else {
        panic!("expected Suspended, got {outcome:?}");
    };
    let AwaitReason::Clarification { question_id } = reason else {
        panic!("expected AwaitReason::Clarification, got {reason:?}");
    };

    // 第一次装配（提问之前）：只有 intent 一个 block，还没有任何澄清。
    {
        let log = open_log(dir.path());
        let contexts = context_assembled_events(&log, &run_id);
        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].blocks.len(), 1, "回答之前不该凭空多出 block");
    }

    rt.answer_clarification(
        &run_id,
        &question_id,
        Some("opt-no"),
        Some(FREE_TEXT_ANSWER),
        Actor::Human("u-1".into()),
    )
    .await
    .expect("回答澄清、驱动到底，全程不该有 Err");

    let log = open_log(dir.path());
    let contexts = context_assembled_events(&log, &run_id);
    assert_eq!(
        contexts.len(),
        2,
        "回答之后应该有第二次 context.assembled（context_turn 被回退重装）"
    );
    let second = &contexts[1];
    assert_eq!(
        second.blocks.len(),
        2,
        "第二次装配应该比第一次多一个澄清答案的 block：{:?}",
        second.blocks
    );

    // 新增的那个 block 引用的 blob，取出来必须真的含有这次回答的内容——
    // 选中的选项文案与自由文本都要在，这才是"答案真的进了上下文"，
    // 不是只多了一个空壳 block。
    let answer_block = &second.blocks[1];
    assert_eq!(answer_block.source, "clarification_answer");
    let content = blob_text(&log, &answer_block.content_hash);
    assert!(
        content.contains("否，再等等"),
        "装配进上下文的内容应该含被选中选项的文案，实得：{content:?}"
    );
    assert!(
        content.contains(FREE_TEXT_ANSWER),
        "装配进上下文的内容应该含自由文本回答，实得：{content:?}"
    );
}

// ————————————————————————————————————————————————————————————
// 5. 问题正文、选项文案、自由文本答案都在 blob 里，不在 payload——
//    扫一遍整条 Log 的 payload，查不到这些文本。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn none_of_the_sensitive_text_leaks_into_any_event_payload() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path(), CLARIFY_WITH_OPTIONS_FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt.start(&run_id, INTENT_TEXT).await.unwrap();
    let RunOutcome::Suspended { reason, .. } = outcome else {
        panic!("expected Suspended, got {outcome:?}");
    };
    let AwaitReason::Clarification { question_id } = reason else {
        panic!("expected AwaitReason::Clarification, got {reason:?}");
    };
    rt.answer_clarification(
        &run_id,
        &question_id,
        Some("opt-no"),
        Some(FREE_TEXT_ANSWER),
        Actor::Human("u-1".into()),
    )
    .await
    .unwrap();

    let log = open_log(dir.path());
    let events = log.events(&run_id, 0, None).unwrap();

    // 注意：`intent.declared`/`model.responded`/`model.requested` 这些事件
    // 本身早就只留 blob 引用，不把模型原始响应文本嵌进 payload——这里检查
    // 的是"事件体序列化之后的 JSON"里查不到这些字符串，覆盖的是 payload
    // 这一层，不是整条 Run Log（blob 内容本就该含有它们，那是它们唯一
    // 该在的地方）。
    let sensitive = [
        "是，立即发起催收",
        "否，再等等",
        FREE_TEXT_ANSWER,
        "是否对某某公司的12万逾期发起催收？",
    ];
    for event in &events {
        let payload = serde_json::to_string(&event.body).expect("EventBody 可序列化");
        for needle in sensitive {
            assert!(
                !payload.contains(needle),
                "{} 事件的 payload 不该含业务文本 {needle:?}：{payload}",
                event.body.kind()
            );
        }
    }
}
