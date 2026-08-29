use evo_model::{FixtureAdapter, Message, ModelAdapter, ModelRequest, PriceTable, request_digest};
use evo_protocol::RunId;
use evo_protocol::events::accounting::{CostDimension, CostUnit, Currency};
use evo_protocol::events::model::{ModelParams, Usage};

const FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\"}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

const PRICING: &str = r#"
version = "poc-1"
currency = "CNY"

[[model]]
provider = "fixture"
model = "fixture-v1"
input_micros_per_token = 1
output_micros_per_token = 2
cache_read_micros_per_token = 0
cache_write_micros_per_token = 0
"#;

fn req() -> ModelRequest {
    ModelRequest {
        messages: vec![Message {
            role: "user".into(),
            content: "做账龄表".into(),
        }],
        params: ModelParams {
            temperature: 0.0,
            max_tokens: None,
        },
    }
}

#[tokio::test]
async fn fixture_returns_responses_in_order() {
    let a = FixtureAdapter::from_json_str(FIXTURES).unwrap();
    assert_eq!(a.provider(), "fixture");
    let first = a.call(&req()).await.unwrap();
    assert!(first.text.contains("tool_call"));
    let second = a.call(&req()).await.unwrap();
    assert!(second.text.contains("finish"));
}

#[tokio::test]
async fn running_out_of_fixtures_is_an_error_not_a_silent_repeat() {
    let a = FixtureAdapter::from_json_str(FIXTURES).unwrap();
    a.call(&req()).await.unwrap();
    a.call(&req()).await.unwrap();
    assert!(
        a.call(&req()).await.is_err(),
        "用尽 fixture 必须报错，否则回放会静默走偏"
    );
}

#[test]
fn request_digest_is_stable_and_content_sensitive() {
    let a = request_digest(&req());
    assert_eq!(a, request_digest(&req()));
    let mut other = req();
    other.messages[0].content = "换个说法".into();
    assert_ne!(a, request_digest(&other));
}

#[test]
fn pricing_produces_one_charge_per_non_zero_unit() {
    let t = PriceTable::from_toml_str(PRICING).unwrap();
    let usage = Usage {
        input: 120,
        output: 40,
        cache_read: 0,
        cache_write: 0,
    };
    let dim = CostDimension {
        principal: "u-1".into(),
        team: None,
        run_id: RunId::from("r-1"),
        skill: None,
        tool: None,
    };
    let charges = t.charges("fixture", "fixture-v1", &usage, &dim, Some(0));
    assert_eq!(charges.len(), 2, "cache 用量为 0 时不产生记账行");
    let input = charges
        .iter()
        .find(|c| c.unit == CostUnit::InputToken)
        .unwrap();
    assert_eq!(input.quantity, 120);
    assert_eq!(input.unit_price_micros, 1);
    assert_eq!(input.amount_micros, 120);
    assert_eq!(input.currency, Currency::CNY);
    assert_eq!(
        input.price_table_ver, "poc-1",
        "改价不能改历史账，版本号必须落进事件"
    );
}

#[test]
fn amounts_are_integers_so_the_books_balance() {
    let t = PriceTable::from_toml_str(PRICING).unwrap();
    let usage = Usage {
        input: 3,
        output: 7,
        cache_read: 0,
        cache_write: 0,
    };
    let dim = CostDimension {
        principal: "u-1".into(),
        team: None,
        run_id: RunId::from("r-1"),
        skill: None,
        tool: None,
    };
    let total: u64 = t
        .charges("fixture", "fixture-v1", &usage, &dim, None)
        .iter()
        .map(|c| c.amount_micros)
        .sum();
    assert_eq!(total, 3 + 7 * 2);
}

#[test]
fn an_unknown_model_yields_no_charges_rather_than_a_wrong_number() {
    let t = PriceTable::from_toml_str(PRICING).unwrap();
    let usage = Usage {
        input: 10,
        output: 10,
        cache_read: 0,
        cache_write: 0,
    };
    let dim = CostDimension {
        principal: "u-1".into(),
        team: None,
        run_id: RunId::from("r-1"),
        skill: None,
        tool: None,
    };
    assert!(t.charges("openai", "gpt-9", &usage, &dim, None).is_empty());
}
