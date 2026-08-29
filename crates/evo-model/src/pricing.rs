use crate::adapter::ModelError;
use evo_protocol::events::accounting::{CostCharged, CostDimension, CostUnit, Currency};
use evo_protocol::events::model::Usage;
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
struct PriceFile {
    version: String,
    currency: Currency,
    #[serde(default, rename = "model")]
    models: Vec<PriceEntry>,
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
    ) -> Vec<CostCharged> {
        let Some(e) = self
            .file
            .models
            .iter()
            .find(|e| e.provider == provider && e.model == model)
        else {
            // 表里没有就不出账，而不是按 0 出一笔「看起来对」的账
            return Vec::new();
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
            .map(|(unit, quantity, unit_price_micros)| CostCharged {
                effect_id: None,
                turn,
                unit,
                quantity,
                unit_price_micros,
                amount_micros: quantity * unit_price_micros,
                currency: self.file.currency,
                price_table_ver: self.file.version.clone(),
                dimension: dimension.clone(),
            })
            .collect()
    }
}
