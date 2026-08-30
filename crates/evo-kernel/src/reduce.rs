use crate::rng::DeterministicRng;
use crate::state::{AwaitReason, ContextRecord, EffectState, RunState, RunStatus};
use evo_protocol::events::effect::ToolResultStatus;
use evo_protocol::events::lifecycle::{CompletionStatus, SuspendReason};
use evo_protocol::ids::RunId;
use evo_protocol::{Event, EventBody};

/// `ToolResult`（正常结算）与 `ApprovalDenied`/`ApprovalExpired`（终结但不
/// 结算）共用的收尾：一个 effect 跑到终态后，检查本 turn 是否所有 effect
/// 都已终结——是的话推进到下一个 turn。`EffectState::is_resolved` 把
/// `Settled` 与 `Denied` 一视同仁：两者都不再产生后续事件，`decide` 都不
/// 需要继续等。
fn advance_turn_if_all_effects_resolved(s: &mut RunState) {
    if s.pending_effects.values().all(EffectState::is_resolved) {
        s.turn += 1;
    }
}

/// 纯函数。入参只有 &RunState 与 &Event，两者都是纯数据。
///
/// 注意：**不许读 `event.recorded_at`**。那是 daemon 的写入时刻，
/// 内核对时间的唯一来源是 env.sampled（01 §5）。
pub fn reduce(state: &RunState, event: &Event) -> RunState {
    debug_assert!(
        event.seq >= state.last_seq,
        "event.seq ({}) < state.last_seq ({}): 事件必须按 seq 非递减顺序喂进来。\
         `events()` 保证按 seq 升序返回；出现倒退说明调用方绕过了这个排序保证 \
         （回放器从快照恢复时会把快照所在 seq 的那条事件重新喂一遍，\
         此时 event.seq == state.last_seq，属于合法情况，故用 >= 而非 >）。",
        event.seq,
        state.last_seq
    );
    let mut s = state.clone();
    s.last_seq = event.seq;

    match &event.body {
        EventBody::RunCreated(e) => {
            s.budget = e.budget;
            s.status = RunStatus::Running;
        }
        EventBody::IntentDeclared(e) => {
            s.intent = Some(e.intent_ref.clone());
        }
        EventBody::EnvSampled(e) => {
            s.turn = e.turn;
            s.clock_ms = e.wall_clock_ms;
            s.rng = DeterministicRng::from_seed(&e.rng_seed);
            s.env = e.env.clone();
            s.env_sampled_turn = Some(e.turn);
        }
        EventBody::ContextAssembled(e) => {
            s.context = Some(ContextRecord {
                turn: e.turn,
                profile: e.profile.clone(),
                block_count: e.blocks.len() as u64,
                taint_level: e.taint_level,
                total_token_estimate: e.total_token_estimate,
            });
            s.taint = s.taint.join(e.taint_level);
            for b in &e.blocks {
                s.cites.insert(b.cite_id.clone());
            }
            s.context_turn = Some(e.turn);
        }
        EventBody::ModelRequested(_) => {}
        EventBody::ModelResponded(e) => {
            s.budget_used.tokens += e.usage.input + e.usage.output;
        }
        EventBody::PlanStep(e) => {
            s.taint = s.taint.join(e.taint_inherited);
            s.last_plan = Some(e.clone());
            s.plan_turn = Some(e.turn);
        }
        EventBody::ToolRequested(e) => {
            s.pending_effects
                .insert(e.effect_id.clone(), EffectState::Requested);
        }
        EventBody::PolicyEvaluated(_) | EventBody::ImpactEstimated(_) => {}
        EventBody::EffectDispatched(e) => {
            s.pending_effects
                .insert(e.effect_id.clone(), EffectState::Dispatched);
        }
        EventBody::ToolResult(e) => {
            // `Denied` 是「Gateway 判定不放行」的结算，effect 从未执行——
            // 它落在与 `approval.denied` 同一个终态上，不是 `Settled`。
            // 把它记成 `Settled` 会让「这个 effect 到底跑没跑过」在状态里
            // 分辨不出来，而 daemon 恰恰要靠这个区分决定要不要补派。
            let terminal = match e.status {
                ToolResultStatus::Denied => EffectState::Denied,
                _ => EffectState::Settled,
            };
            s.pending_effects.insert(e.effect_id.clone(), terminal);
            // 外部返回一律 tainted（02 §2 步骤 ③ 的前提）
            s.taint = s.taint.join(e.taint);
            for c in &e.cites_produced {
                s.cites.insert(c.clone());
            }
            if e.status == ToolResultStatus::Error {
                // 错误不终止 run，交给下一 turn 的模型处理
            }
            // 一个 effect 结算完，本 turn 结束，进入下一 turn
            advance_turn_if_all_effects_resolved(&mut s);
        }
        EventBody::CostCharged(e) => {
            s.budget_used.amount_micros += e.amount_micros;
        }
        EventBody::Checkpoint(_) => {
            s.last_checkpoint_seq = Some(event.seq);
        }
        EventBody::RunCompleted(e) => {
            // Ok/Partial 都记成 Completed——Partial 尚无产生方，先按「完成」
            // 处理；Failed 是唯一改变终态的分支（终审 I1 之前，这里无条件写
            // Completed，把内核 decide 判出来的失败悄悄抹掉）。
            s.status = match e.status {
                CompletionStatus::Failed => RunStatus::Failed,
                CompletionStatus::Ok | CompletionStatus::Partial => RunStatus::Completed,
            };
        }
        EventBody::RunSuspended(e) => {
            // 挂起不是特殊状态机，就是 awaiting 有值时 decide 返回空
            // （03 §4）。这条事件是那个「有值」的唯一落点。
            s.status = RunStatus::Suspended;
            s.awaiting = Some(match e.reason {
                // Gateway 已经先发了一条 `approval.requested`（`reduce`
                // 处理它时把 approval_id/effect_id 记进了
                // `pending_approvals`），这里从台账里取出那条未决审批，
                // 拼成携带完整上下文的 `AwaitReason::Approval`——不从
                // `RunSuspended` 本身取，因为它的 payload 里根本没有
                // approval_id/effect_id 这两个字段（该事件只携带
                // `SuspendReason` 这个粗粒度分类 + 一个 blob 引用）。
                SuspendReason::AwaitingApproval => {
                    let (approval_id, effect_id) = s
                        .pending_approvals
                        .iter()
                        .next_back()
                        .map(|(a, e)| (a.clone(), e.clone()))
                        .expect(
                            "run.suspended{reason: AwaitingApproval} 之前必须先有一条 \
                             approval.requested 把审批记进 pending_approvals——\
                             这是 daemon 侧的发送顺序保证，不是内核能自己满足的前提",
                        );
                    AwaitReason::Approval {
                        approval_id,
                        effect_id,
                    }
                }
                // `SuspendReason::AwaitingHuman` 的文档原话是「澄清式追问：
                // 需要人回答问题，不一定经过审批队列」——它就是
                // `clarification.requested` 之后的那次挂起，同构于上面的
                // 审批分支：从 `pending_question`（`clarification.requested`
                // 写入）里取当前这条追问的 question_id。
                SuspendReason::AwaitingHuman => {
                    let question_id = s.pending_question.clone().expect(
                        "run.suspended{reason: AwaitingHuman} 之前必须先有一条 \
                         clarification.requested 把 question_id 写进 pending_question",
                    );
                    AwaitReason::Clarification { question_id }
                }
                SuspendReason::BudgetExhausted => AwaitReason::Budget,
                // 「人工暂停，不归入以上任何一类具体原因」——没有配套的
                // approval_id/question_id 可取，`AwaitReason` 里也没有专门
                // 为它开的变体（`Human{step}` 是 [P2] 人机混合队列，语义
                // 是「流程走到了某个人工步骤」，与这里的「无缘由手动暂停」
                // 不是一回事，勉强复用会让将来读 Log 的人误以为两者同源）。
                // 挪用最不相关联的 `ExternalEvent` 变体，把 kind 写成一个
                // 稳定标记，好过瞎猜语义相近的变体、或者 panic 掉一整条
                // 合法事件。
                SuspendReason::Paused => AwaitReason::ExternalEvent {
                    kind: "manual_pause".to_owned(),
                },
            });
        }
        EventBody::RunResumed(_) => {
            // 恢复是显式事件：awaiting 的清空只由这里负责，
            // approval.granted / clarification.answered 都不许直接清空它
            // ——否则「谁能往 Log 追加事件谁就能恢复任务」这条推论会失去
            // 唯一的落点，Log 里也查不出「谁、什么时候恢复的」。
            s.status = RunStatus::Running;
            s.awaiting = None;
        }
        EventBody::RunFailed(_) => {
            s.status = RunStatus::Failed;
        }
        EventBody::ApprovalRequested(e) => {
            s.pending_approvals
                .insert(e.approval_id.clone(), e.effect_id.clone());
        }
        EventBody::ApprovalGranted(e) => {
            // 只销账，不清 awaiting（红线①）：审批通过只是记录了「人批
            // 了」，effect 真正往前走要等 Gateway 真的派发、`reduce` 收到
            // `effect.dispatched`/`tool.result`；run 真正重新跑起来要等
            // 随后那条 `run.resumed`。
            //
            // 但「人批过了」这件事必须在状态里留下正向痕迹：effect 从
            // `Requested` 走到 `Approved`。daemon 的补派逻辑读的就是它
            // （见 `EffectState::Approved` 的注释与 `Runtime::resume`）。
            // 只在 effect 还停在 `Requested` 时改写：一条迟到的
            // `approval.granted` 不该把已经派发/结算/被拒的 effect 拽回来。
            if let Some(effect_id) = s.pending_approvals.remove(&e.approval_id)
                && let Some(st) = s.pending_effects.get_mut(&effect_id)
                && *st == EffectState::Requested
            {
                *st = EffectState::Approved;
            }
        }
        EventBody::ApprovalDenied(e) => {
            // 被拒的 effect 标成 EffectState::Denied——见该变体上的注释：
            // 复用 pending_effects 这张已有的单一真源，而不是另开一张
            // 「被拒集合」。它是与 Settled 并列的终态，所以同样要检查
            // 「本 turn 是否所有 effect 都已终结」，否则 decide 会因为
            // 这个 effect 永远停在非终态而卡死整个 turn 循环，即使随后
            // 来了 run.resumed 清空 awaiting 也无济于事——decide 卡在
            // pending_effects 的阻塞检查上，永远走不到重新规划那一步。
            if let Some(effect_id) = s.pending_approvals.remove(&e.approval_id) {
                s.pending_effects.insert(effect_id, EffectState::Denied);
                advance_turn_if_all_effects_resolved(&mut s);
            }
        }
        EventBody::ApprovalExpired(e) => {
            // 到期未处理与被拒是同一种终态：这个 effect 都不会再被派发。
            // 处理方式与 ApprovalDenied 对称。
            if let Some(effect_id) = s.pending_approvals.remove(&e.approval_id) {
                s.pending_effects.insert(effect_id, EffectState::Denied);
                advance_turn_if_all_effects_resolved(&mut s);
            }
        }
        EventBody::ClarificationRequested(e) => {
            s.pending_question = Some(e.question_id.clone());
        }
        EventBody::ClarificationAnswered(_) => {
            // 不完全同构于 ApprovalGranted：审批场景里 effect 本身还没
            // 结算，run.resumed 之后 decide 自然会去等执行面回流；但澄清
            // 场景里 `last_plan.intent == Clarify` 已经是「一个 turn 内的
            // 终态」——`decide` 会一直卡在 `plan_turn == Some(turn)` 这条
            // 分支上，拿着同一个 `last_plan` 反复判成 Clarify，再发一遍
            // `AskClarification`（这就是本次要修的死循环：只清
            // pending_question 不够，run 永远推不动）。
            //
            // 修法：把这一 turn 的进度标记回退到「需要重新装配上下文」——
            // `context_turn` 与 `plan_turn` 一并清空。`decide` 由此依次
            // 产出 `AssembleContext` → `CallModel`，模型才有机会带着答案
            // 重新规划，而不是对着同一份（不含答案的）`last_plan` 打转。
            //
            // 为什么连 `context_turn` 也退：上下文是在提问之前装配的，
            // 里面没有那个答案；只退 `plan_turn` 的话模型会拿着一份不含
            // 答案的上下文重新规划，跟没回答没区别。
            //
            // 交接：把答案真正塞进重新装配的上下文，是装配器
            // （AssembleContext 的执行方）的责任，不在这条 reduce 分支、
            // 也不在本任务范围内——这里只负责让状态机不再原地打转。装配器
            // 如果不落实这一步，这个能力仍然是「形式上不空转、内容上空转」。
            s.pending_question = None;
            s.context_turn = None;
            s.plan_turn = None;
        }
        // 这两个变体本切片仍不产生（各自的事件定义处已注明：产物区、
        // 上下文压缩都排在后续切片），继续留白，交给对应切片处理。
        EventBody::ContextCompacted(_) | EventBody::ArtifactEmitted(_) => {}
    }
    s
}

/// 从空状态起把一串事件叠起来。回放就是它。
pub fn fold(run_id: &RunId, events: &[Event]) -> RunState {
    events
        .iter()
        .fold(RunState::new(run_id), |s, e| reduce(&s, e))
}
