use crate::state::RunState;
use sha2::{Digest, Sha256};

/// 规范化序列化后 sha256。
///
/// 用 canonical CBOR 而不是 JSON：JSON 的 map 序列化顺序依赖插入顺序，
/// 而 state_hash 不稳定 = 判据 3 静默失效。CBOR 的 canonical 形式对 map key
/// 有确定的排序规则，嵌套结构一并覆盖。
pub fn state_hash(state: &RunState) -> [u8; 32] {
    let mut buf = Vec::new();
    ciborium::into_writer(state, &mut buf).expect("RunState 必须可序列化");
    Sha256::digest(&buf).into()
}

pub fn state_hash_hex(state: &RunState) -> String {
    state_hash(state)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::RunState;
    use evo_protocol::RunId;

    #[test]
    fn hash_is_stable_across_calls() {
        let s = RunState::new(&RunId::from("r-1"));
        assert_eq!(state_hash(&s), state_hash(&s));
    }

    #[test]
    fn hash_changes_when_state_changes() {
        let a = RunState::new(&RunId::from("r-1"));
        let mut b = a.clone();
        b.turn = 1;
        assert_ne!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn map_insertion_order_does_not_affect_the_hash() {
        // BTreeMap 已经排序，这条测试防的是将来有人改成 HashMap
        let mut a = RunState::new(&RunId::from("r-1"));
        a.env.insert("A".into(), "1".into());
        a.env.insert("B".into(), "2".into());
        let mut b = RunState::new(&RunId::from("r-1"));
        b.env.insert("B".into(), "2".into());
        b.env.insert("A".into(), "1".into());
        assert_eq!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn hash_hex_is_64_chars() {
        let s = RunState::new(&RunId::from("r-1"));
        assert_eq!(state_hash_hex(&s).len(), 64);
    }
}
