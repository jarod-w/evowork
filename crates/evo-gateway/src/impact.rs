use crate::manifest::ToolManifest;
use evo_protocol::events::effect::{ImpactEstimated, ImpactPrecision, ImpactTarget};
use evo_protocol::ids::EffectId;

/// 三级降级（02 §3）。第 2、3 级不阻塞接入——
/// 如果只有实现了 preview 的工具才能接入，门槛会高到没人接，
/// 最后一定有人加个后门绕过 Gateway。
pub fn estimate(
    effect_id: &EffectId,
    manifest: &ToolManifest,
    params: &serde_json::Value,
) -> ImpactEstimated {
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

    // 阶段 1 不真的调 preview：声明了 preview 的工具在阶段 2 才走第 1 级。
    // 此处按 targets 能否静态提取区分第 2、3 级——两级的 precision 都是 declared_only。
    ImpactEstimated {
        effect_id: effect_id.clone(),
        targets,
        externals: manifest.egress.clone(),
        est_cost_micros: None,
        precision: ImpactPrecision::DeclaredOnly,
    }
}
