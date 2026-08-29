use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! string_id {
    ($($name:ident),* $(,)?) => {
        $(
            #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
            #[serde(transparent)]
            pub struct $name(String);

            impl $name {
                pub fn as_str(&self) -> &str { &self.0 }
                pub fn into_inner(self) -> String { self.0 }
            }
            impl From<&str> for $name {
                fn from(s: &str) -> Self { Self(s.to_owned()) }
            }
            impl From<String> for $name {
                fn from(s: String) -> Self { Self(s) }
            }
            impl fmt::Display for $name {
                fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str(&self.0)
                }
            }
        )*
    };
}

string_id!(RunId, EffectId, ApprovalId, CiteId, ToolId, LeaseId, ExecutorId, ArtifactId, CheckpointId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_id_roundtrips_as_a_bare_string() {
        let id = RunId::from("r-001");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"r-001\"");
        assert_eq!(serde_json::from_str::<RunId>(&json).unwrap(), id);
    }

    #[test]
    fn ids_are_ordered_so_btreemap_iteration_is_stable() {
        let mut v = [EffectId::from("e-2"), EffectId::from("e-1")];
        v.sort();
        assert_eq!(v[0].as_str(), "e-1");
    }
}
