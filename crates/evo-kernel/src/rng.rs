use serde::{Deserialize, Serialize};

/// 内核唯一的随机数来源。seed 只由 env.sampled 写入，算法是纯函数（splitmix64）。
///
/// 不引 `rand`：判据 3 要求内核里没有任何非确定性来源，而 `rand` 会把
/// `getrandom` 拖进依赖树（CI 检查 1 会直接 fail）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeterministicRng {
    pub seed: u64,
    pub counter: u64,
}

impl DeterministicRng {
    pub fn from_seed(seed: &str) -> Self {
        // FNV-1a：把任意字符串塌成 u64，纯函数，无依赖
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in seed.as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        Self { seed: h, counter: 0 }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.counter = self.counter.wrapping_add(1);
        let mut z = self.seed.wrapping_add(self.counter.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_gives_the_same_sequence() {
        let mut a = DeterministicRng::from_seed("seed-0");
        let mut b = DeterministicRng::from_seed("seed-0");
        let sa: Vec<u64> = (0..5).map(|_| a.next_u64()).collect();
        let sb: Vec<u64> = (0..5).map(|_| b.next_u64()).collect();
        assert_eq!(sa, sb);
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = DeterministicRng::from_seed("seed-0");
        let mut b = DeterministicRng::from_seed("seed-1");
        assert_ne!(a.next_u64(), b.next_u64());
    }

    #[test]
    fn counter_advances_so_replay_can_be_verified() {
        let mut a = DeterministicRng::from_seed("seed-0");
        a.next_u64();
        assert_eq!(a.counter, 1);
    }
}
