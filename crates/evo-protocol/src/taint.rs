use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaintLevel {
    #[default]
    Clean,
    Tainted,
}

impl TaintLevel {
    /// 污点只升不降：任何一块 tainted，整体就是 tainted。
    pub fn join(self, other: Self) -> Self {
        if self == Self::Tainted || other == Self::Tainted { Self::Tainted } else { Self::Clean }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    UserDirect,
    OrgTrusted,
    Untrusted,
}

impl TrustLevel {
    pub fn taint(self) -> TaintLevel {
        match self {
            Self::UserDirect | Self::OrgTrusted => TaintLevel::Clean,
            Self::Untrusted => TaintLevel::Tainted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taint_only_goes_up() {
        assert_eq!(TaintLevel::Clean.join(TaintLevel::Clean), TaintLevel::Clean);
        assert_eq!(TaintLevel::Clean.join(TaintLevel::Tainted), TaintLevel::Tainted);
        assert_eq!(TaintLevel::Tainted.join(TaintLevel::Clean), TaintLevel::Tainted);
    }

    #[test]
    fn untrusted_content_is_tainted() {
        assert_eq!(TrustLevel::Untrusted.taint(), TaintLevel::Tainted);
        assert_eq!(TrustLevel::UserDirect.taint(), TaintLevel::Clean);
    }
}
