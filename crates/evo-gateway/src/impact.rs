use crate::manifest::ToolManifest;
use evo_protocol::events::effect::{ImpactEstimated, ImpactPrecision, ImpactTarget};
use evo_protocol::ids::EffectId;

/// 工具 `preview` 方法的产出——喂给 [`estimate`] 换来第 1 级降级
/// （`ImpactPrecision::Exact`）。
///
/// **这是纯数据，Gateway 自己从不调用 preview。** `Gateway::admit` 撞见一个
/// manifest 里声明了 `preview` 的工具时，会先停下来产出
/// `GatewayAction::NeedPreview`；调用方（daemon）拿着 `PendingAdmit` 里的
/// 工具名与参数去问 executor，把答案包成这个类型，再调用
/// `Gateway::admit_with_preview` 续跑——preview 那次 IO 因此发生在 Gateway
/// 之外，`admit` 依然是一个不做 IO 的纯函数。
#[derive(Clone, Debug, PartialEq)]
pub struct PreviewOutcome {
    /// 精确的将写入 / 将触碰的资源清单，由工具的 preview 方法给出，
    /// 不是从参数静态猜的。
    pub targets: Vec<ImpactTarget>,
    pub est_cost_micros: Option<u64>,
}

/// 三级降级（02 §3）。第 2、3 级不阻塞接入——
/// 如果只有实现了 preview 的工具才能接入，门槛会高到没人接，
/// 最后一定有人加个后门绕过 Gateway。
///
/// - `preview` 是 `Some`：第 1 级，`ImpactPrecision::Exact`。`targets` 直接
///   取自 preview 的产出，不再从参数重新静态提取——preview 的答案理应比
///   静态提取更准，两者若有分歧，以 preview 为准。
/// - `preview` 是 `None`：第 2、3 级，两级的 `precision` 都是
///   `ImpactPrecision::DeclaredOnly`，本函数不额外区分——区别只在 `targets`
///   是否非空：manifest 能从参数静态提取出资源就非空（第 2 级，「将触碰
///   这些资源」）；提取不出来（`shell.exec` 一类，第 3 级）就是空清单，
///   「将在沙箱内执行、出口受白名单约束」这句话由调用方结合
///   `EffectRequest.class` + 本结构体的 `externals` 表达；命令原文本来就在
///   `ToolRequested.params_ref` / `EffectRequest.params_ref` 里，不需要在
///   这里再重复一份内容（红线①：具体内容一律走 blob，不进事件 payload）。
pub fn estimate(
    effect_id: &EffectId,
    manifest: &ToolManifest,
    params: &serde_json::Value,
    preview: Option<&PreviewOutcome>,
) -> ImpactEstimated {
    if let Some(preview) = preview {
        return ImpactEstimated {
            effect_id: effect_id.clone(),
            targets: preview.targets.clone(),
            externals: manifest.egress.clone(),
            est_cost_micros: preview.est_cost_micros,
            precision: ImpactPrecision::Exact,
        };
    }

    let targets: Vec<ImpactTarget> = manifest
        .targets
        .iter()
        .filter_map(|t| t.resolve(params))
        .map(|(resource, op)| ImpactTarget {
            resource,
            op,
            detail_ref: None,
        })
        .collect();

    ImpactEstimated {
        effect_id: effect_id.clone(),
        targets,
        externals: manifest.egress.clone(),
        est_cost_micros: None,
        precision: ImpactPrecision::DeclaredOnly,
    }
}
