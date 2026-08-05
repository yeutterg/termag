use crate::protocol::{RuntimeInventory, RuntimePane, RuntimeSession, RuntimeTab, Space};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::Command,
    sync::mpsc,
    task::JoinHandle,
    time::{sleep, timeout, Duration},
};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const SESSION_DISCOVERY_TTL: Duration = Duration::from_secs(30);

type SessionCache = Mutex<Option<(Instant, Vec<HerdrSession>)>>;
static SESSION_CACHE: OnceLock<SessionCache> = OnceLock::new();
type StatusStyleCache = Mutex<Option<(Option<PathBuf>, Option<SystemTime>, String)>>;
static STATUS_STYLE_CACHE: OnceLock<StatusStyleCache> = OnceLock::new();

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
    let mut available = true;
    let indicator_style = status_indicator_style();
    let mut snapshots = Vec::new();
    for session in sessions.into_iter().filter(|session| session.running) {
        match snapshot(&session, &indicator_style).await {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(_) => available = false,
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
        .map(Vec::as_slice)
        .unwrap_or_default();
    let tabs = snapshot
        .get("tabs")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut result_spaces = Vec::new();
    for workspace in snapshot
        .get("workspaces")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let workspace_id = string(workspace, "workspace_id").unwrap_or_default();
        if workspace_id.is_empty() {
            continue;
        }
        let mut result_tabs = Vec::new();
        for tab in tabs
            .iter()
            .filter(|tab| text_ref(tab, "workspace_id") == Some(workspace_id.as_str()))
        {
            let tab_id = string(tab, "tab_id").unwrap_or_default();
            let tab_layout = layouts.get(tab_id.as_str()).copied();
            let focused_pane_id = tab_layout.and_then(|layout| string(layout, "focused_pane_id"));
            let tab_focused = boolean(tab, "focused")
                || text_ref(workspace, "active_tab_id") == Some(tab_id.as_str());
            let mut result_panes = Vec::new();
            for pane in panes
                .iter()
                .filter(|pane| text_ref(pane, "tab_id") == Some(tab_id.as_str()))
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
            name: string(workspace, "label").unwrap_or_else(|| "Space".to_owned()),
            ordinal: integer(workspace, "number"),
            status: status(workspace.get("agent_status")),
            focused: boolean(workspace, "focused"),
            active_tab_id: string(workspace, "active_tab_id"),
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
    let modified = config_path
        .as_ref()
        .and_then(|path| std::fs::metadata(path).ok()?.modified().ok());
    let cache = STATUS_STYLE_CACHE.get_or_init(|| Mutex::new(None));
    if let Some((cached_path, cached_modified, style)) =
        cache.lock().expect("status style cache poisoned").as_ref()
    {
        if cached_path == &config_path && cached_modified == &modified {
            return style.clone();
        }
    }
    let raw = config_path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok());
    let mut style = "dots".to_owned();
    let Some(raw) = raw else {
        *cache.lock().expect("status style cache poisoned") =
            Some((config_path, modified, style.clone()));
        return style;
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
            style = "symbols".to_owned();
            break;
        }
    }
    *cache.lock().expect("status style cache poisoned") =
        Some((config_path, modified, style.clone()));
    style
}

pub async fn mutate(session_name: &str, method: &str, params: Value) -> Result<Value> {
    let sessions = discover_sessions().await?;
    let session = sessions
        .into_iter()
        .find(|session| session.name == session_name && session.running)
        .with_context(|| format!("HerdR session {session_name:?} is not running"))?;
    request(&session.socket_path, method, params).await
}

pub fn spawn_event_watchers() -> mpsc::Receiver<()> {
    let (event_tx, event_rx) = mpsc::channel(1);
    tokio::spawn(async move {
        let mut watchers: HashMap<String, JoinHandle<()>> = HashMap::new();
        loop {
            let sessions = discover_sessions().await.unwrap_or_default();
            let running = sessions
                .iter()
                .filter(|session| session.running)
                .map(|session| session.name.clone())
                .collect::<HashSet<_>>();
            watchers.retain(|name, task| {
                if !running.contains(name) || task.is_finished() {
                    task.abort();
                    false
                } else {
                    true
                }
            });
            for session in sessions.into_iter().filter(|session| session.running) {
                if watchers.contains_key(&session.name) {
                    continue;
                }
                let tx = event_tx.clone();
                let name = session.name.clone();
                watchers.insert(
                    name,
                    tokio::spawn(async move {
                        loop {
                            if subscribe_once(&session, &tx).await.is_err() {
                                break;
                            }
                            if tx.is_closed() {
                                break;
                            }
                            sleep(Duration::from_millis(250)).await;
                        }
                    }),
                );
            }
            if event_tx.is_closed() {
                for task in watchers.into_values() {
                    task.abort();
                }
                break;
            }
            sleep(Duration::from_secs(5)).await;
        }
    });
    event_rx
}

async fn subscribe_once(session: &HerdrSession, event_tx: &mpsc::Sender<()>) -> Result<()> {
    let snapshot = request(&session.socket_path, "session.snapshot", json!({})).await?;
    let protocol = snapshot
        .pointer("/result/snapshot/protocol")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let pane_ids = snapshot
        .pointer("/result/snapshot/panes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|pane| pane.get("pane_id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let mut subscriptions = vec![
        json!({ "type": "workspace.created" }),
        json!({ "type": "workspace.updated" }),
        json!({ "type": "workspace.metadata_updated" }),
        json!({ "type": "workspace.renamed" }),
        json!({ "type": "workspace.moved" }),
        json!({ "type": "workspace.closed" }),
        json!({ "type": "workspace.focused" }),
        json!({ "type": "tab.created" }),
        json!({ "type": "tab.closed" }),
        json!({ "type": "tab.focused" }),
        json!({ "type": "tab.renamed" }),
        json!({ "type": "tab.moved" }),
        json!({ "type": "pane.created" }),
        json!({ "type": "pane.closed" }),
        json!({ "type": "pane.updated" }),
        json!({ "type": "pane.focused" }),
        json!({ "type": "pane.moved" }),
        json!({ "type": "pane.exited" }),
        json!({ "type": "pane.agent_detected" }),
        json!({ "type": "layout.updated" }),
    ];
    // Multi-workspace reorder events were added with HerdR protocol 19.
    // Sending the unknown tagged variant makes protocol-17/0.7.5 reject the
    // entire subscription, so keep the baseline list version-compatible.
    if protocol >= 19 {
        subscriptions.push(json!({ "type": "workspace.reordered" }));
    }
    for pane_id in pane_ids {
        subscriptions.push(json!({
            "type": "pane.agent_status_changed",
            "pane_id": pane_id,
        }));
    }
    let mut stream = timeout(
        Duration::from_secs(2),
        UnixStream::connect(&session.socket_path),
    )
    .await??;
    let subscribe = json!({
        "id": "termag:events",
        "method": "events.subscribe",
        "params": { "subscriptions": subscriptions },
    });
    stream
        .write_all(serde_json::to_string(&subscribe)?.as_bytes())
        .await?;
    stream.write_all(b"\n").await?;
    let mut reader = BufReader::new(stream);
    // Reconnect periodically so newly-created panes gain parameterized status
    // subscriptions without retaining stale per-pane server state forever.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let line = match timeout(remaining, next_bounded_line(&mut reader, 256 * 1024)).await {
            Ok(result) => result?,
            Err(_) => break,
        };
        let Some(line) = line else {
            break;
        };
        let value = serde_json::from_slice::<Value>(&line)?;
        if let Some(error) = value.get("error") {
            bail!("HerdR event subscription failed: {error}");
        }
        if value.get("event").is_some() {
            let _ = event_tx.try_send(());
        }
    }
    Ok(())
}

async fn request(socket: &Path, method: &str, params: Value) -> Result<Value> {
    let mut stream = timeout(Duration::from_secs(2), UnixStream::connect(socket)).await??;
    let request = json!({ "id": "termag", "method": method, "params": params });
    stream
        .write_all(serde_json::to_string(&request)?.as_bytes())
        .await?;
    stream.write_all(b"\n").await?;
    let mut reader = BufReader::new(stream);
    let line = timeout(
        Duration::from_secs(3),
        next_bounded_line(&mut reader, MAX_RESPONSE_BYTES),
    )
    .await??
    .context("HerdR API closed without a response")?;
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
    statuses
        .map(|status| match status {
            "blocked" => (0, "blocked"),
            "working" => (1, "working"),
            "done" => (2, "done"),
            "idle" => (3, "idle"),
            _ => (4, "unknown"),
        })
        .min_by_key(|(priority, _)| *priority)
        .map_or_else(|| "unknown".to_owned(), |(_, status)| status.to_owned())
}

fn string(value: &Value, key: &str) -> Option<String> {
    text_ref(value, key).map(ToOwned::to_owned)
}
fn text_ref<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
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

async fn next_bounded_line<R>(reader: &mut R, max_bytes: usize) -> Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len() + consumed > max_bytes {
            bail!("HerdR response exceeded {max_bytes} bytes");
        }
        line.extend_from_slice(&available[..consumed]);
        let complete = available[consumed - 1] == b'\n';
        reader.consume(consumed);
        if complete {
            return Ok(Some(line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_herdr_status_vocabulary() {
        assert_eq!(status(Some(&json!("done"))), "done");
        assert_eq!(status(Some(&json!("waiting"))), "unknown");
    }

    #[tokio::test]
    #[ignore = "requires a live HerdR session"]
    async fn live_event_subscription_is_accepted() {
        let session = discover_sessions()
            .await
            .unwrap()
            .into_iter()
            .find(|session| session.running)
            .expect("running HerdR session");
        let (tx, _rx) = mpsc::channel(1);
        match timeout(Duration::from_secs(2), subscribe_once(&session, &tx)).await {
            // A healthy subscription normally remains open, so timeout is
            // success. A clean early close is also acceptable; a protocol
            // rejection returns Err immediately and fails the test.
            Err(_) | Ok(Ok(())) => {}
            Ok(Err(error)) => panic!("{error:#}"),
        }
    }
}
