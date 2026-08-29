use crate::impact::{PreviewOutcome, estimate};
use crate::manifest::{ManifestRegistry, ToolManifest};
use evo_policy::{PolicyContext, PolicyDecision, PolicyHook, RiskLevel};
use evo_protocol::EventBody;
use evo_protocol::effect::{CapabilityToken, EffectClass, EffectRequest};
use evo_protocol::events::effect::{
    ExecutionMode, ImpactEstimated, PolicyDecisionKind, PolicyEvaluated, ToolRequested, ToolResult,
    ToolResultStatus,
};
use evo_protocol::events::model::PlannedCall;
use evo_protocol::ids::{CiteId, EffectId, RunId, ToolId};
use evo_protocol::taint::TaintLevel;

pub struct AdmitRequest {
    pub effect_id: EffectId,
    pub run_id: RunId,
    pub turn: u32,
    pub call: PlannedCall,
    /// 参数正文。daemon 从 blob 取出后传进来。
    pub params: serde_json::Value,
    pub taint: TaintLevel,
    pub cites_referenced: Vec<CiteId>,
    pub capability: CapabilityToken,
    pub mode: ExecutionMode,
}

pub enum GatewayAction {
    Dispatch(EffectRequest),
    DryRun {
        request: EffectRequest,
    },
    Deny {
        reason_code: String,
    },
    AwaitApproval {
        risk: RiskLevel,
        request: EffectRequest,
        /// 构造 `approval.requested.impact_ref` 的素材。**这里给的是值，
        /// 不是 blob 引用**——Gateway 不持有 blob store 句柄，把值存成 blob
        /// 是 daemon 的活；`impact_ref` 本身按红线①不能把具体资源标识
        /// 直接放进 `ApprovalRequested` 的 payload，所以 daemon 必须先把
        /// 这个值写成 blob，再把返回的 `BlobRef` 填进
        /// `ApprovalRequested.impact_ref`。
        impact: ImpactEstimated,
    },
    /// manifest 给这个工具声明了 `preview`——第 1 级 dry-run 降级要调它才能
    /// 拿到 `ImpactPrecision::Exact`，而调用 preview 是一次 IO。`admit` 是
    /// 纯函数、不持有任何执行句柄，做不了 IO，于是在这里停下来，把「已经
    /// 走到第⑥步」的全部上下文原样封进 [`PendingAdmit`] 还给调用方：调用方
    /// （daemon）拿着它问 executor 要 preview 结果，再调用
    /// [`Gateway::admit_with_preview`] 从这一步续跑。
    ///
    /// 这次分岔之前的事件（`tool.requested`、`policy.evaluated`）已经在
    /// `GatewayVerdict::events` 里——daemon 应该立刻落盘，不要攒到
    /// preview 问完才一起写：那样会让还没决定要不要问 preview 之前的
    /// 治理动作也悬在内存里，一次 IO 超时就可能连审计都丢了。
    NeedPreview {
        pending: PendingAdmit,
    },
}

/// [`GatewayAction::NeedPreview`] 的续跑凭据：`admit` 走到「要不要调
/// preview」这一步时已经算出的全部上下文，纯数据、不含任何句柄。
///
/// 之所以需要这个类型：两段式准入把一次 `admit` 拆成了 `admit` +
/// `admit_with_preview` 两次调用，中间隔着 daemon 去问 executor 的一次
/// await——`admit_with_preview` 不能从头再算一遍（policy 已经判过了，
/// 重新判一遍如果策略源在这期间变了，两次判定可能对不上），所以第一次
/// 调用必须把判到一半的状态原样交出来，第二次原样收回去接着做。
pub struct PendingAdmit {
    manifest: ToolManifest,
    params: serde_json::Value,
    decision: PolicyDecision,
    request: EffectRequest,
    mode: ExecutionMode,
}

impl PendingAdmit {
    /// manifest 里声明的 preview 方法名——调用方拿它去问 executor 该调哪个
    /// preview。`NeedPreview` 只会在这个字段是 `Some` 时被构造出来，这里
    /// `expect` 的是 Gateway 自己的不变量，不是调用方可能犯的错。
    pub fn preview_method(&self) -> &str {
        self.manifest
            .preview
            .as_deref()
            .expect("PendingAdmit 只会在 manifest 声明了 preview 时被构造")
    }

    /// 要预览哪个工具调用。
    pub fn tool(&self) -> &ToolId {
        &self.request.tool
    }

    /// 该工具调用的参数正文，preview 调用同样需要它。
    pub fn params(&self) -> &serde_json::Value {
        &self.params
    }
}

/// Gateway 的产出：要追加哪些事件，以及接下来做什么。
///
/// **Gateway 不写 Log**——由 daemon 落盘。这是「只有 evo-daemon 写 Run Log」
/// 在类型上的形态。
pub struct GatewayVerdict {
    pub events: Vec<EventBody>,
    pub action: GatewayAction,
}

/// 把策略判定收紧到「至少 floor 这一档」。
///
/// **这是整个 Gateway 里唯一允许改变策略判定的地方。** 闸门只能收紧、
/// 绝不能放宽——`Deny` 原样返回，`Allow` 提升为 `RequireApproval{floor}`，
/// 已经是 `RequireApproval` 的取 `max(原 risk, floor)`。
///
/// 抽成独立函数是有原因的：这条不变量在本组件上破过三次（闸门不存在、
/// 闸门无条件覆盖 Deny、闸门硬编码 risk 导致降级）。把它收进一个函数后，
/// 新增的第三个闸门只要复用它就自动获得这条不变量，调用方写不出「放宽」。
fn tighten(decision: PolicyDecision, floor: RiskLevel) -> PolicyDecision {
    match decision {
        PolicyDecision::Deny { reason_code } => PolicyDecision::Deny { reason_code },
        PolicyDecision::Allow => PolicyDecision::RequireApproval { risk: floor },
        PolicyDecision::RequireApproval { risk } => PolicyDecision::RequireApproval {
            risk: risk.max(floor),
        },
    }
}

pub struct Gateway {
    policy: Box<dyn PolicyHook>,
    manifests: ManifestRegistry,
}

impl Gateway {
    pub fn new(policy: Box<dyn PolicyHook>, manifests: ManifestRegistry) -> Self {
        Self { policy, manifests }
    }

    /// 六步管线。每一步产出一个事件——**「Gateway 做了什么」本身可回放、可举证**，
    /// 而不是一堆日志行。每一步失败也要先写事件再返回。
    pub fn admit(&self, req: AdmitRequest) -> GatewayVerdict {
        let mut events = Vec::new();

        // 无 manifest 即最严
        let (manifest, manifest_missing) = match self.manifests.get(&req.call.tool) {
            Some(m) => (m.clone(), false),
            None => (ManifestRegistry::strictest_default(&req.call.tool), true),
        };

        let targets: Vec<_> = manifest
            .targets
            .iter()
            .filter_map(|t| t.resolve(&req.params))
            .map(|(r, _)| r)
            .collect();

        let request = EffectRequest {
            effect_id: req.effect_id.clone(),
            run_id: req.run_id.clone(),
            turn: req.turn,
            tool: req.call.tool.clone(),
            params_ref: req.call.params_ref.clone(),
            params_digest: req.call.params_digest.clone(),
            class: manifest.class,
            targets: targets.clone(),
            egress: manifest.egress.clone(),
            reversible: manifest.reversible,
            taint: req.taint,
            cites_referenced: req.cites_referenced.clone(),
            capability: req.capability.clone(),
        };

        events.push(EventBody::ToolRequested(ToolRequested {
            effect_id: request.effect_id.clone(),
            turn: request.turn,
            tool: request.tool.clone(),
            params_ref: request.params_ref.clone(),
            params_digest: request.params_digest.clone(),
            class: request.class,
            declared_targets: request.targets.clone(),
            declared_egress: request.egress.clone(),
            reversible: request.reversible,
            cites_referenced: request.cites_referenced.clone(),
        }));

        let push_policy = |events: &mut Vec<EventBody>, decision, rules, reason: &str| {
            events.push(EventBody::PolicyEvaluated(PolicyEvaluated {
                effect_id: req.effect_id.clone(),
                decision,
                rules_hit: rules,
                policy_ver: self.policy.version().to_owned(),
                reason_code: reason.to_owned(),
            }));
        };

        // ① 身份解析 + ② 能力校验：权限只能收窄
        if !req.capability.allows(&request.tool) {
            push_policy(
                &mut events,
                PolicyDecisionKind::Deny,
                Vec::new(),
                "capability_scope",
            );
            return GatewayVerdict {
                events,
                action: GatewayAction::Deny {
                    reason_code: "capability_scope".to_owned(),
                },
            };
        }

        // ③ 污点检查 —— **在 ④ 之前，且不可被策略放行**
        let taint_gate = req.taint == TaintLevel::Tainted && request.class != EffectClass::Read;

        // ④ 策略求值
        let ctx = PolicyContext {
            tool: request.tool.clone(),
            class: request.class,
            taint: req.taint,
            targets,
            reversible: request.reversible,
        };
        let (policy_decision, rules_hit) = self.policy.evaluate_with_trace(&ctx);

        // 结构性闸门：manifest 缺失 / 污点未清，都只能把策略判定收紧
        // （交给 `tighten` 去做），不能把 Deny 放宽——闸门是拿来加严的，
        // 不是拿来盖过拒绝的。`tighten` 对 Deny 原样返回，所以无论
        // manifest_missing / taint_gate 是否为真，Deny 都不会被两个闸门
        // 改动；只有 Allow（或策略本身已经给出的 RequireApproval）才可能
        // 被进一步收紧。
        //
        // manifest 闸门优先于污点闸门判断：两者都命中时，reason_code 报
        // "no_manifest"——manifest 缺失意味着我们连这个工具的
        // class / reversible / targets 都是猜的最严默认值，这比"工具形状
        // 已知、只是这次调用摸到了污点数据"更从根上不可信，优先暴露这个
        // 更严重的理由。manifest 闸门的下限是全局最高档 L3，天然不低于
        // 污点闸门的 L2，所以两者都命中时，即使只跑 manifest 闸门也不会漏
        // 收紧污点闸门本该收紧的部分。
        //
        // 污点闸门用 `tighten(.., L2)`：只保证「至少 L2」，绝不能把策略
        // 已经判到 L3 的调用压回 L2。之前的写法是硬编码 L2，等于把 policy
        // 判过的更高档位悄悄降级，是这轮 re-review 修的缺陷。
        let (decision, reason) = if manifest_missing {
            (tighten(policy_decision, RiskLevel::L3), "no_manifest")
        } else if taint_gate {
            (tighten(policy_decision, RiskLevel::L2), "taint_gate")
        } else {
            (policy_decision, "policy")
        };

        match &decision {
            PolicyDecision::Deny { reason_code } => {
                push_policy(
                    &mut events,
                    PolicyDecisionKind::Deny,
                    rules_hit,
                    reason_code,
                );
                return GatewayVerdict {
                    events,
                    action: GatewayAction::Deny {
                        reason_code: reason_code.clone(),
                    },
                };
            }
            PolicyDecision::RequireApproval { .. } => {
                push_policy(
                    &mut events,
                    PolicyDecisionKind::RequireApproval,
                    rules_hit,
                    reason,
                );
            }
            PolicyDecision::Allow => {
                push_policy(&mut events, PolicyDecisionKind::Allow, rules_hit, reason);
            }
        }

        // ⑥ 影响预估 —— **无条件执行，不只在 dry-run 时执行**
        //
        // 工具声明了 preview：第 1 级降级要调它才能拿到 `Exact` 精度，而那是
        // 一次 IO。`admit` 做不了 IO，就在这里停下来，把状态封进
        // `PendingAdmit` 交还调用方——`tool.requested` / `policy.evaluated`
        // 这两条已经决定了的事件已经在 `events` 里，随这次返回一起落盘。
        if manifest.preview.is_some() {
            return GatewayVerdict {
                events,
                action: GatewayAction::NeedPreview {
                    pending: PendingAdmit {
                        manifest,
                        params: req.params.clone(),
                        decision,
                        request,
                        mode: req.mode,
                    },
                },
            };
        }

        // 未声明 preview：直接按第 2/3 级（`DeclaredOnly`）估。targets 能不能
        // 从参数静态提取出来，区分的正是这两级——见 `impact::estimate` 的
        // 文档注释。
        let impact = estimate(&req.effect_id, &manifest, &req.params, None);
        Self::finish(events, decision, request, req.mode, impact)
    }

    /// 从 [`GatewayAction::NeedPreview`] 续跑。
    ///
    /// `preview` 是调用方问过 executor 之后拿到的结果：`Some` 换来第 1 级
    /// （`ImpactPrecision::Exact`），`None` 表示放弃 preview、退回第 2/3 级
    /// （`DeclaredOnly`）——比如 executor 暂时没有真正实现这个 preview
    /// 方法。**退回 `None` 不阻塞接入**，这正是判据 1 的延伸：宁可精度差一
    /// 档，也不能因为一个工具的 preview 没接好就把它挡在 Gateway 外面。
    pub fn admit_with_preview(
        &self,
        pending: PendingAdmit,
        preview: Option<PreviewOutcome>,
    ) -> GatewayVerdict {
        let PendingAdmit {
            manifest,
            params,
            decision,
            request,
            mode,
        } = pending;
        let impact = estimate(&request.effect_id, &manifest, &params, preview.as_ref());
        Self::finish(Vec::new(), decision, request, mode, impact)
    }

    /// `admit` 与 `admit_with_preview` 共用的尾段：拿到影响预估之后，两者
    /// 剩下的分支（审批 / dry-run 降级 / 派发）完全一样，抽出来避免两处
    /// 各写一份、容易漏改其中一处。
    ///
    /// `decision` 到这里不会是 `Deny`——`admit` 在算出 `Deny` 的那一刻就
    /// 已经提前返回，从不会走到这个分支来构造 `PendingAdmit` 或直接调用
    /// `finish`。
    fn finish(
        mut events: Vec<EventBody>,
        decision: PolicyDecision,
        request: EffectRequest,
        mode: ExecutionMode,
        impact: ImpactEstimated,
    ) -> GatewayVerdict {
        events.push(EventBody::ImpactEstimated(impact.clone()));

        let risk = match decision {
            PolicyDecision::RequireApproval { risk } => Some(risk),
            PolicyDecision::Allow => None,
            PolicyDecision::Deny { .. } => {
                unreachable!("Deny 在 admit() 里已经提前返回，不会走到 finish() 才被发现")
            }
        };

        if let Some(risk) = risk {
            return GatewayVerdict {
                events,
                action: GatewayAction::AwaitApproval {
                    risk,
                    request,
                    impact,
                },
            };
        }

        // dry-run：Write / External 降级为 record-only，Read / Compute 照常执行
        if mode == ExecutionMode::DryRun && request.class.suppressed_in_dry_run() {
            events.push(EventBody::ToolResult(ToolResult {
                effect_id: request.effect_id.clone(),
                status: ToolResultStatus::DryRun,
                output_ref: None,
                bytes: None,
                taint: TaintLevel::Clean,
                cites_produced: Vec::new(),
                actual_targets: Vec::new(),
                actual_egress: Vec::new(),
            }));
            return GatewayVerdict {
                events,
                action: GatewayAction::DryRun { request },
            };
        }

        GatewayVerdict {
            events,
            action: GatewayAction::Dispatch(request),
        }
    }
}

#[cfg(test)]
mod tighten_tests {
    // `tighten` 的穷举单元测试：Deny / Allow / RequireApproval{L1,L2,L3} ×
    // floor ∈ {L2, L3}，共 10 格全部断言。这比在集成测试里手工搭一整套
    // Gateway/Policy/Manifest 才能验证一次闸门行为要小、要快、覆盖还更全——
    // 集成测试（tests/pipeline.rs）验证的是闸门在真实管线里的接线，两者是
    // 不同层次，都要留着，谁也不能替代谁。
    use super::tighten;
    use evo_policy::{PolicyDecision, RiskLevel};

    fn deny() -> PolicyDecision {
        PolicyDecision::Deny {
            reason_code: "some_rule".to_owned(),
        }
    }

    #[test]
    fn deny_stays_deny_under_l2_floor() {
        assert_eq!(tighten(deny(), RiskLevel::L2), deny());
    }

    #[test]
    fn deny_stays_deny_under_l3_floor() {
        assert_eq!(tighten(deny(), RiskLevel::L3), deny());
    }

    #[test]
    fn allow_becomes_require_approval_at_l2_floor() {
        assert_eq!(
            tighten(PolicyDecision::Allow, RiskLevel::L2),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L2
            }
        );
    }

    #[test]
    fn allow_becomes_require_approval_at_l3_floor() {
        assert_eq!(
            tighten(PolicyDecision::Allow, RiskLevel::L3),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L3
            }
        );
    }

    #[test]
    fn require_approval_l1_is_lifted_to_l2_floor() {
        assert_eq!(
            tighten(
                PolicyDecision::RequireApproval {
                    risk: RiskLevel::L1
                },
                RiskLevel::L2
            ),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L2
            }
        );
    }

    #[test]
    fn require_approval_l1_is_lifted_to_l3_floor() {
        assert_eq!(
            tighten(
                PolicyDecision::RequireApproval {
                    risk: RiskLevel::L1
                },
                RiskLevel::L3
            ),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L3
            }
        );
    }

    #[test]
    fn require_approval_l2_stays_l2_under_l2_floor() {
        assert_eq!(
            tighten(
                PolicyDecision::RequireApproval {
                    risk: RiskLevel::L2
                },
                RiskLevel::L2
            ),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L2
            }
        );
    }

    #[test]
    fn require_approval_l2_is_lifted_to_l3_floor() {
        assert_eq!(
            tighten(
                PolicyDecision::RequireApproval {
                    risk: RiskLevel::L2
                },
                RiskLevel::L3
            ),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L3
            }
        );
    }

    #[test]
    fn require_approval_l3_never_downgraded_by_l2_floor() {
        assert_eq!(
            tighten(
                PolicyDecision::RequireApproval {
                    risk: RiskLevel::L3
                },
                RiskLevel::L2
            ),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L3
            }
        );
    }

    #[test]
    fn require_approval_l3_stays_l3_under_l3_floor() {
        assert_eq!(
            tighten(
                PolicyDecision::RequireApproval {
                    risk: RiskLevel::L3
                },
                RiskLevel::L3
            ),
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L3
            }
        );
    }
}
