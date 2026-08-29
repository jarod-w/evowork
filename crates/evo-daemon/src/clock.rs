/// daemon 是唯一允许读时钟的地方。内核通过 env.sampled 间接看到时间。
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
    fn now_rfc3339(&self) -> String;
    /// 每 turn 的 rng seed。内核唯一的随机数来源。
    fn seed(&self) -> String;
}

pub struct RealClock;

impl Clock for RealClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn now_rfc3339(&self) -> String {
        // 不引 chrono：daemon 只需要一个可读的时间戳字符串，
        // 而 recorded_at 从不参与任何计算（内核读不到它）。
        format!("epoch-ms:{}", self.now_ms())
    }

    fn seed(&self) -> String {
        format!("seed:{}", self.now_ms())
    }
}

/// 测试用。每次调用推进 1000ms，序列确定——
/// 没有它，端到端测试的 Log 每次都不一样，回放对不上就无从判断是谁的错。
pub struct FixedClock {
    start_ms: u64,
    ticks: std::sync::atomic::AtomicU64,
}

impl FixedClock {
    pub fn new(start_ms: u64) -> Self {
        Self {
            start_ms,
            ticks: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        let n = self.ticks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.start_ms + n * 1000
    }

    fn now_rfc3339(&self) -> String {
        format!("epoch-ms:{}", self.start_ms)
    }

    fn seed(&self) -> String {
        "seed-fixed".to_owned()
    }
}
