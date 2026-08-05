use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySet {
    pub inventory_snapshots: bool,
    pub typed_mutations: bool,
    pub shared_terminal_streams: bool,
    pub herdr: bool,
    pub tmux: bool,
    pub directory_policy: bool,
    pub power_policy: bool,
    pub git_operations: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InventorySnapshot {
    pub revision: u64,
    pub roots: Vec<DirectoryRoot>,
    pub runtimes: Vec<RuntimeInventory>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryRoot {
    pub key: String,
    pub path: String,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RuntimeInventory {
    Tmux {
        available: bool,
        sessions: Vec<RuntimeSession>,
    },
    Herdr {
        available: bool,
        sessions: Vec<RuntimeSession>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSession {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub status_indicators: Option<String>,
    pub path: Option<String>,
    pub status: String,
    pub spaces: Vec<Space>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub name: String,
    pub ordinal: i64,
    pub status: String,
    pub focused: bool,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<RuntimeTab>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTab {
    pub id: String,
    pub name: String,
    pub ordinal: i64,
    pub status: String,
    pub focused: bool,
    pub layout: Option<Value>,
    pub panes: Vec<RuntimePane>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePane {
    pub id: String,
    pub terminal_id: String,
    pub name: String,
    pub ordinal: i64,
    pub status: String,
    pub focused: bool,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub agent: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Incoming {
    pub request_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(flatten)]
    pub data: serde_json::Map<String, Value>,
}

impl Incoming {
    pub fn string(&self, key: &str) -> Option<String> {
        self.data.get(key)?.as_str().map(ToOwned::to_owned)
    }
    pub fn bool(&self, key: &str) -> bool {
        self.data.get(key).and_then(Value::as_bool).unwrap_or(false)
    }
    pub fn u16(&self, key: &str, fallback: u16) -> u16 {
        self.data
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok())
            .unwrap_or(fallback)
    }
    pub fn value(&self, key: &str) -> Option<&Value> {
        self.data.get(key)
    }
}
