use crate::adapter::ModelError;
use evo_protocol::events::accounting::{CostCharged, CostDimension, CostUnit, Currency};
use evo_protocol::events::model::Usage;
use evo_protocol::ids::EffectId;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct PriceEntry {
    provider: String,
    model: String,
    input_micros_per_token: u64,
    output_micros_per_token: u64,
    #[serde(default)]
    cache_read_micros_per_token: u64,
    #[serde(default)]
    cache_write_micros_per_token: u64,
}

#[derive(Debug, Deserialize)]
struct ToolPriceEntry {
    name: String,
    call_micros: u64,
}

#[derive(Debug, Deserialize)]
struct PriceFile {
    version: String,
    currency: Currency,
    #[serde(default, rename = "model")]
    models: Vec<PriceEntry>,
    #[serde(default, rename = "tool")]
    tools: Vec<ToolPriceEntry>,
}

/// 产品自己的定价表，版本化。
///
/// 金额算在我们这边：codex 的 TokenUsage 只有 token 数，金额来自后端，
/// 换任何供应商都拿不到（01 §4.5）。
pub struct PriceTable {
    file: PriceFile,
}

impl PriceTable {
    pub fn from_toml_str(s: &str) -> Result<Self, ModelError> {
        Ok(Self {
            file: toml::from_str(s)?,
        })
    }

    pub fn from_path(p: &Path) -> Result<Self, ModelError> {
        Self::from_toml_str(&std::fs::read_to_string(p)?)
    }

    pub fn version(&self) -> &str {
        &self.file.version
    }

    /// 定价表里是否收录了这个 provider/model。
    ///
    /// 用来区分「真免费」（`charges` 返回空列表，但 usage 全为 0）和
    /// 「未定价」（`charges` 返回空列表，是因为表里根本没有这个模型）——
    /// 对财务而言这两者含义完全不同。
    pub fn covers(&self, provider: &str, model: &str) -> bool {
        self.file
            .models
            .iter()
            .any(|e| e.provider == provider && e.model == model)
    }

    /// 一次模型往返产生的全部记账行。用量为 0 的单位不产生记账行。
    ///
    /// **micros 整数，不用浮点**——财务客户，账要对得上。
    pub fn charges(
        &self,
        provider: &str,
        model: &str,
        usage: &Usage,
        dimension: &CostDimension,
        turn: Option<u32>,
    ) -> Result<Vec<CostCharged>, ModelError> {
        let Some(e) = self
            .file
            .models
            .iter()
            .find(|e| e.provider == provider && e.model == model)
        else {
            // 表里没有就不出账，而不是按 0 出一笔「看起来对」的账
            return Ok(Vec::new());
        };

        let rows = [
            (CostUnit::InputToken, usage.input, e.input_micros_per_token),
            (
                CostUnit::OutputToken,
                usage.output,
                e.output_micros_per_token,
            ),
            (
                CostUnit::CacheRead,
                usage.cache_read,
                e.cache_read_micros_per_token,
            ),
            (
                CostUnit::CacheWrite,
                usage.cache_write,
                e.cache_write_micros_per_token,
            ),
        ];

        rows.into_iter()
            .filter(|(_, qty, _)| *qty > 0)
            .map(|(unit, quantity, unit_price_micros)| {
                let amount_micros =
                    quantity
                        .checked_mul(unit_price_micros)
                        .ok_or(ModelError::CostOverflow {
                            quantity,
                            unit_price_micros,
                        })?;
                Ok(CostCharged {
                    effect_id: None,
                    turn,
                    unit,
                    quantity,
                    unit_price_micros,
                    amount_micros,
                    currency: self.file.currency,
                    price_table_ver: self.file.version.clone(),
                    dimension: dimension.clone(),
                })
            })
            .collect()
    }

    pub fn currency(&self) -> Currency {
        self.file.currency
    }

    /// 一次已执行的工具调用按次计费。表里没有、或 `call_micros` 为 0，
    /// 返回空——未定价不等于免费记账一行 0。
    pub fn tool_charges(
        &self,
        tool: &str,
        effect_id: &EffectId,
        turn: Option<u32>,
        dimension: &CostDimension,
    ) -> Result<Vec<CostCharged>, ModelError> {
        let Some(e) = self.file.tools.iter().find(|e| e.name == tool) else {
            return Ok(Vec::new());
        };
        if e.call_micros == 0 {
            return Ok(Vec::new());
        }
        Ok(vec![CostCharged {
            effect_id: Some(effect_id.clone()),
            turn,
            unit: CostUnit::Call,
            quantity: 1,
            unit_price_micros: e.call_micros,
            amount_micros: e.call_micros,
            currency: self.file.currency,
            price_table_ver: self.file.version.clone(),
            dimension: dimension.clone(),
        }])
    }
}
