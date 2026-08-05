use crate::protocol::{RuntimeInventory, RuntimePane, RuntimeSession, RuntimeTab, Space};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::Command,
    time::{timeout, Duration},
};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const SESSION_DISCOVERY_TTL: Duration = Duration::from_secs(30);

type SessionCache = Mutex<Option<(Instant, Vec<HerdrSession>)>>;
static SESSION_CACHE: OnceLock<SessionCache> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
pub struct HerdrSession {
    pub name: String,
    pub running: bool,
    pub socket_path: PathBuf,
}

#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<HerdrSession>,
}

pub async fn inventory() -> RuntimeInventory {
    let Ok(sessions) = discover_sessions().await else {
        return RuntimeInventory::Herdr {
            available: false,
            sessions: Vec::new(),
        };
    };
    let available = true;
    let indicator_style = status_indicator_style();
    let mut snapshots = Vec::new();
    for session in sessions.into_iter().filter(|session| session.running) {
        if let Ok(snapshot) = snapshot(&session, &indicator_style).await {
            snapshots.push(snapshot);
        }
    }
    RuntimeInventory::Herdr {
        available,
        sessions: snapshots,
    }
}

pub async fn discover_sessions() -> Result<Vec<HerdrSession>> {
    let cache = SESSION_CACHE.get_or_init(|| Mutex::new(None));
    if let Some((cached_at, sessions)) = cache.lock().expect("session cache poisoned").as_ref() {
        if cached_at.elapsed() < SESSION_DISCOVERY_TTL {
            return Ok(sessions.clone());
        }
    }

    let output = Command::new("herdr")
        .args(["session", "list", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .context("herdr is not installed")?;
    if !output.status.success() {
        bail!("herdr session list failed");
    }
    let sessions = serde_json::from_slice::<SessionList>(&output.stdout)?.sessions;
    *cache.lock().expect("session cache poisoned") = Some((Instant::now(), sessions.clone()));
    Ok(sessions)
}

async fn snapshot(session: &HerdrSession, indicator_style: &str) -> Result<RuntimeSession> {
    let response = request(&session.socket_path, "session.snapshot", json!({})).await?;
    let snapshot = response
        .pointer("/result/snapshot")
        .context("HerdR snapshot missing result.snapshot")?;
    let layouts: HashMap<&str, &Value> = snapshot
        .get("layouts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|layout| Some((layout.get("tab_id")?.as_str()?, layout)))
        .collect();
    let panes = snapshot
        .get("panes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tabs = snapshot
        .get("tabs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut result_spaces = Vec::new();
    for workspace in snapshot
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let workspace_id = string(&workspace, "workspace_id").unwrap_or_default();
        if workspace_id.is_empty() {
            continue;
        }
        let mut result_tabs = Vec::new();
        for tab in tabs
            .iter()
            .filter(|tab| string(tab, "workspace_id").as_deref() == Some(&workspace_id))
        {
            let tab_id = string(tab, "tab_id").unwrap_or_default();
            let tab_layout = layouts.get(tab_id.as_str()).copied();
            let focused_pane_id = tab_layout.and_then(|layout| string(layout, "focused_pane_id"));
            let tab_focused = boolean(tab, "focused")
                || string(&workspace, "active_tab_id").as_deref() == Some(tab_id.as_str());
            let mut result_panes = Vec::new();
            for pane in panes
                .iter()
                .filter(|pane| string(pane, "tab_id").as_deref() == Some(&tab_id))
            {
                let pane_id = string(pane, "pane_id").unwrap_or_default();
                let status = status(pane.get("agent_status"));
                result_panes.push(RuntimePane {
                    id: pane_id.clone(),
                    terminal_id: string(pane, "terminal_id").unwrap_or_else(|| pane_id.clone()),
                    name: string(pane, "terminal_title_stripped")
                        .or_else(|| string(pane, "terminal_title"))
                        .unwrap_or_else(|| "Terminal".to_owned()),
                    ordinal: numeric_suffix(&string(pane, "pane_id").unwrap_or_default()),
                    status,
                    focused: tab_focused
                        && (boolean(pane, "focused")
                            || focused_pane_id.as_deref() == Some(pane_id.as_str())),
                    cwd: string(pane, "foreground_cwd").or_else(|| string(pane, "cwd")),
                    command: None,
                    agent: string(pane, "agent"),
                });
            }
            result_panes.sort_by_key(|pane| pane.ordinal);
            result_tabs.push(RuntimeTab {
                id: tab_id.clone(),
                name: string(tab, "label").unwrap_or_else(|| "Terminal".to_owned()),
                ordinal: integer(tab, "number"),
                status: status(tab.get("agent_status")),
                focused: tab_focused,
                layout: tab_layout.cloned(),
                panes: result_panes,
            });
        }
        result_tabs.sort_by_key(|tab| tab.ordinal);
        result_spaces.push(Space {
            id: workspace_id,
            name: string(&workspace, "label").unwrap_or_else(|| "Space".to_owned()),
            ordinal: integer(&workspace, "number"),
            status: status(workspace.get("agent_status")),
            focused: boolean(&workspace, "focused"),
            active_tab_id: string(&workspace, "active_tab_id"),
            tabs: result_tabs,
        });
    }
    result_spaces.sort_by_key(|space| space.ordinal);
    let overall = aggregate(result_spaces.iter().map(|space| space.status.as_str()));
    Ok(RuntimeSession {
        id: session.name.clone(),
        name: session.name.clone(),
        version: string(snapshot, "version"),
        status_indicators: Some(indicator_style.to_owned()),
        path: None,
        status: overall,
        spaces: result_spaces,
    })
}

fn status_indicator_style() -> String {
    let config_path = std::env::var_os("HERDR_CONFIG_PATH")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .map(|path| path.join("herdr/config.toml"))
        })
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|path| path.join(".config/herdr/config.toml"))
        });
    let Some(raw) = config_path.and_then(|path| std::fs::read_to_string(path).ok()) else {
        return "dots".to_owned();
    };
    let mut section = "";
    for raw_line in raw.lines() {
        let line = raw_line.split('#').next().unwrap_or_default().trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = line.trim_matches(['[', ']']).trim();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if ((section == "ui" && key == "status_indicators") || key == "ui.status_indicators")
            && value.trim().trim_matches(['\'', '"']) == "symbols"
        {
            return "symbols".to_owned();
        }
    }
    "dots".to_owned()
}

pub async fn mutate(session_name: &str, method: &str, params: Value) -> Result<Value> {
    let sessions = discover_sessions().await?;
    let session = sessions
        .into_iter()
        .find(|session| session.name == session_name && session.running)
        .with_context(|| format!("HerdR session {session_name:?} is not running"))?;
    request(&session.socket_path, method, params).await
}

async fn request(socket: &Path, method: &str, params: Value) -> Result<Value> {
    let mut stream = timeout(Duration::from_secs(2), UnixStream::connect(socket)).await??;
    let request = json!({ "id": "termag", "method": method, "params": params });
    stream
        .write_all(serde_json::to_string(&request)?.as_bytes())
        .await?;
    stream.write_all(b"\n").await?;
    let mut line = Vec::new();
    timeout(
        Duration::from_secs(3),
        BufReader::new(stream).read_until(b'\n', &mut line),
    )
    .await??;
    if line.len() > MAX_RESPONSE_BYTES {
        bail!("HerdR response exceeded 4 MiB");
    }
    let value: Value = serde_json::from_slice(&line)?;
    if let Some(error) = value.get("error") {
        bail!("HerdR API error: {error}");
    }
    Ok(value)
}

fn status(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str).unwrap_or("unknown") {
        "blocked" => "blocked",
        "working" => "working",
        "done" => "done",
        "idle" => "idle",
        _ => "unknown",
    }
    .to_owned()
}

fn aggregate<'a>(statuses: impl Iterator<Item = &'a str>) -> String {
    let all: Vec<&str> = statuses.collect();
    for candidate in ["blocked", "working", "done", "idle", "unknown"] {
        if all.contains(&candidate) {
            return candidate.to_owned();
        }
    }
    "unknown".to_owned()
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToOwned::to_owned)
}
fn integer(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}
fn boolean(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn numeric_suffix(value: &str) -> i64 {
    value
        .rsplit(['p', ':'])
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_herdr_status_vocabulary() {
        assert_eq!(status(Some(&json!("done"))), "done");
        assert_eq!(status(Some(&json!("waiting"))), "unknown");
    }
}
