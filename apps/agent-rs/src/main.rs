mod config;
mod fs_policy;
mod herdr;
mod inventory;
mod power;
mod protocol;
mod terminal;
mod tmux;

use anyhow::{Context, Result};
use config::Config;
use futures_util::{SinkExt, StreamExt};
use power::{PowerManager, PowerMode};
use protocol::{CapabilitySet, Incoming, InventorySnapshot, RuntimeInventory, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use terminal::{Registry, Target};
use tokio::time::{interval, sleep, MissedTickBehavior};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    if matches!(std::env::args().nth(1).as_deref(), Some("--version" | "-V")) {
        println!("termag-agent {VERSION}");
        return Ok(());
    }
    let config = Config::load()?;
    eprintln!("[termag-agent] starting v{VERSION} (protocol v{PROTOCOL_VERSION})");
    let mut reconnect = Duration::from_secs(1);
    loop {
        match run_connection(&config).await {
            Ok(ConnectionEnd::Replaced) => return Ok(()),
            Ok(ConnectionEnd::Shutdown) => return Ok(()),
            Ok(ConnectionEnd::Disconnected) => {}
            Err(err) => eprintln!("[termag-agent] connection error: {err:#}"),
        }
        tokio::select! {
            _ = sleep(reconnect) => {}
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
        reconnect = (reconnect * 2).min(Duration::from_secs(30));
    }
}

enum ConnectionEnd {
    Replaced,
    Shutdown,
    Disconnected,
}

async fn run_connection(config: &Config) -> Result<ConnectionEnd> {
    let mut request = config.url.clone().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", config.token))?,
    );
    let (mut socket, _) = connect_async(request)
        .await
        .context("could not connect to broker")?;
    eprintln!("[termag-agent] connected to {}", config.url);
    let started = Instant::now();
    let mut terminal = Registry::new();
    let mut power = PowerManager::new();
    let mut inventory_tick = interval(Duration::from_millis(config.inventory_interval_ms));
    inventory_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut health_tick = interval(Duration::from_secs(30));
    health_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut ping_tick = interval(Duration::from_secs(30));
    ping_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_inventory: Option<InventorySnapshot> = None;

    loop {
        tokio::select! {
            message = socket.next() => {
                let Some(message) = message else { return Ok(ConnectionEnd::Disconnected); };
                match message? {
                    Message::Text(text) => {
                        let incoming: Incoming = match serde_json::from_str(&text) { Ok(value) => value, Err(_) => continue };
                        if incoming.kind == "hello" { continue; }
                        let responses = handle_request(config, &mut terminal, &mut power, incoming).await;
                        for response in responses { socket.send(Message::Text(response.to_string().into())).await?; }
                    }
                    Message::Close(frame) => {
                        if frame.as_ref().is_some_and(|frame| frame.reason == "replaced") { return Ok(ConnectionEnd::Replaced); }
                        return Ok(ConnectionEnd::Disconnected);
                    }
                    Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
                    _ => {}
                }
            }
            event = terminal.next_event() => {
                if let Some(event) = event {
                    for message in terminal.handle_event(event) { socket.send(Message::Text(message.to_string().into())).await?; }
                }
            }
            _ = inventory_tick.tick() => {
                let snapshot = inventory::collect(config).await;
                let changed = last_inventory.as_ref().is_none_or(|previous| previous.roots != snapshot.roots || previous.runtimes != snapshot.runtimes);
                if changed {
                    send_inventory(&mut socket, &snapshot).await?;
                    last_inventory = Some(snapshot);
                }
            }
            _ = health_tick.tick() => {
                let snapshot = if let Some(snapshot) = &last_inventory { snapshot.clone() } else { inventory::collect(config).await };
                let health = health_message(config, &snapshot, terminal.len(), started.elapsed().as_secs());
                socket.send(Message::Text(health.to_string().into())).await?;
            }
            _ = ping_tick.tick() => socket.send(Message::Ping(Vec::new().into())).await?,
            _ = tokio::signal::ctrl_c() => {
                let _ = power.stop().await;
                let _ = socket.close(None).await;
                return Ok(ConnectionEnd::Shutdown);
            }
        }
    }
}

async fn handle_request(
    config: &Config,
    terminal: &mut Registry,
    power: &mut PowerManager,
    incoming: Incoming,
) -> Vec<Value> {
    let request_id = incoming.request_id.clone();
    let result: Result<(Value, Vec<Value>)> = async {
        match incoming.kind.as_str() {
            "terminal-attach" => {
                let stream_id = incoming.string("streamId").context("streamId is required")?;
                let target = Target::from_value(incoming.value("runtimeTarget"), incoming.string("tmuxName"))?;
                let driver = terminal.attach(stream_id, target.clone(), incoming.u16("cols", 80), incoming.u16("rows", 24), incoming.bool("readOnly")).await?;
                Ok((json!({ "runtime": target.runtime, "externalId": target.external_id, "tmuxName": target.external_id }), driver))
            }
            "terminal-input" => {
                terminal.input(&incoming.string("streamId").unwrap_or_default(), incoming.string("data").unwrap_or_default().into_bytes()).await;
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "terminal-resize" => {
                terminal.resize(&incoming.string("streamId").unwrap_or_default(), incoming.u16("cols", 80), incoming.u16("rows", 24)).await;
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "terminal-claim-drive" => {
                let messages = terminal.claim(&incoming.string("streamId").unwrap_or_default()).await;
                Ok((json!({ "ok": true }), messages))
            }
            "terminal-close" => {
                terminal.close(&incoming.string("streamId").unwrap_or_default()).await;
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "inventory.get" | "health-request" => {
                let snapshot = inventory::collect(config).await;
                Ok((serde_json::to_value(snapshot)?, Vec::new()))
            }
            "tmux-list" => {
                let snapshot = inventory::collect(config).await;
                Ok((json!({ "sessions": legacy_tmux(&snapshot) }), Vec::new()))
            }
            "list-directory" => {
                let root = incoming.string("rootKey").context("rootKey is required")?;
                let relative = incoming.string("relativePath").unwrap_or_default();
                Ok((serde_json::to_value(fs_policy::list_directory(config, &root, &relative)?)?, Vec::new()))
            }
            "power.set" | "caffeinate-start" => {
                let mode = incoming.string("mode").as_deref().and_then(PowerMode::parse).unwrap_or(PowerMode::TerminalsAwake);
                let duration = incoming.value("durationMs").and_then(Value::as_u64).map(Duration::from_millis);
                Ok((json!({ "success": true, "state": power.start(mode, duration).await? }), Vec::new()))
            }
            "power.stop" | "caffeinate-stop" => Ok((json!({ "success": true, "state": power.stop().await? }), Vec::new())),
            "power.get" | "caffeinate-status" => Ok((json!({ "state": power.state() }), Vec::new())),
            "runtime.create-session" => {
                let runtime = incoming.string("runtime").unwrap_or_else(|| "tmux".to_owned());
                let name = incoming.string("name").context("name is required")?;
                let cwd = request_cwd(config, &incoming)?;
                if runtime == "herdr" {
                    herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "workspace.create", json!({ "cwd": cwd, "label": name, "focus": false, "env": {} })).await?;
                } else { tmux::create_session(&name, std::path::Path::new(&cwd)).await?; }
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.create-space" => {
                let cwd = request_cwd(config, &incoming)?;
                herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "workspace.create", json!({
                    "cwd": cwd, "label": incoming.string("name"), "focus": false, "env": {},
                })).await?;
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.create-tab" => {
                let runtime = incoming.string("runtime").unwrap_or_else(|| "tmux".to_owned());
                let cwd = request_cwd(config, &incoming)?;
                if runtime == "herdr" {
                    herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "tab.create", json!({
                        "workspace_id": incoming.string("spaceId"), "cwd": cwd, "label": incoming.string("name"), "focus": false, "env": {},
                    })).await?;
                } else {
                    tmux::create_tab(&incoming.string("runtimeSessionId").context("runtimeSessionId is required")?, &incoming.string("name").unwrap_or_else(|| "shell".to_owned()), std::path::Path::new(&cwd)).await?;
                }
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.rename-space" => {
                if incoming.string("runtime").as_deref() == Some("tmux") {
                    tmux::rename_session(
                        &incoming.string("runtimeSessionId").context("runtimeSessionId is required")?,
                        &incoming.string("name").context("name is required")?,
                    ).await?;
                } else {
                    herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "workspace.rename", json!({
                        "workspace_id": incoming.string("spaceId").context("spaceId is required")?, "label": incoming.string("name").context("name is required")?,
                    })).await?;
                }
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.rename-tab" | "tmux-rename-window" => {
                if incoming.string("runtime").as_deref() == Some("herdr") {
                    herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "tab.rename", json!({
                        "tab_id": incoming.string("tabId").context("tabId is required")?, "label": incoming.string("name").context("name is required")?,
                    })).await?;
                } else { tmux::rename_tab(&incoming.string("tabId").or_else(|| incoming.string("tmuxName")).context("tab target is required")?, &incoming.string("name").context("name is required")?).await?; }
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.rename-pane" => {
                if incoming.string("runtime").as_deref() != Some("herdr") {
                    anyhow::bail!("pane rename is only supported for HerdR");
                }
                herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "pane.rename", json!({
                    "pane_id": incoming.string("paneId").context("paneId is required")?, "label": incoming.string("name").context("name is required")?,
                })).await?;
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.close-tab" | "tmux-kill-window" => {
                if incoming.string("runtime").as_deref() == Some("herdr") {
                    herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "tab.close", json!({ "tab_id": incoming.string("tabId").context("tabId is required")? })).await?;
                } else { tmux::close_tab(&incoming.string("tabId").or_else(|| incoming.string("tmuxName")).context("tab target is required")?).await?; }
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.close-pane" => {
                if incoming.string("runtime").as_deref() == Some("tmux") {
                    tmux::close_pane(&incoming.string("paneId").context("paneId is required")?).await?;
                } else {
                    herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "pane.close", json!({ "pane_id": incoming.string("paneId").context("paneId is required")? })).await?;
                }
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.close-space" => {
                herdr::mutate(&incoming.string("runtimeSessionId").unwrap_or_else(|| "default".to_owned()), "workspace.close", json!({ "workspace_id": incoming.string("spaceId").context("spaceId is required")? })).await?;
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "runtime.close-session" | "tmux-kill-session" | "tmux-kill" => {
                tmux::close_session(&incoming.string("runtimeSessionId").or_else(|| incoming.string("tmuxSessionName")).or_else(|| incoming.string("tmuxName")).context("session target is required")?).await?;
                Ok((json!({ "ok": true }), Vec::new()))
            }
            "execute-command" => anyhow::bail!("execute-command was removed in protocol v2; use a typed operation"),
            _ => anyhow::bail!("unknown command: {}", incoming.kind),
        }
    }.await;

    match result {
        Ok((data, mut side_effects)) => {
            if let Some(request_id) = request_id {
                side_effects.insert(0, json!({ "requestId": request_id, "data": data }));
            }
            side_effects
        }
        Err(error) => request_id
            .map(|request_id| vec![json!({ "requestId": request_id, "error": error.to_string() })])
            .unwrap_or_default(),
    }
}

fn request_cwd(config: &Config, incoming: &Incoming) -> Result<String> {
    let cwd = incoming.value("cwd").and_then(Value::as_object);
    let root = incoming.string("rootKey").or_else(|| {
        cwd.and_then(|v| v.get("rootKey"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    });
    let relative = incoming
        .string("relativePath")
        .or_else(|| {
            cwd.and_then(|v| v.get("relativePath"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    Ok(
        fs_policy::resolve_creation_path(config, root.as_deref(), &relative)?
            .to_string_lossy()
            .into_owned(),
    )
}

async fn send_inventory<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    snapshot: &InventorySnapshot,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let capabilities = CapabilitySet {
        inventory_snapshots: true,
        typed_mutations: true,
        shared_terminal_streams: true,
        herdr: inventory::runtime_available(snapshot, "herdr"),
        tmux: inventory::runtime_available(snapshot, "tmux"),
        directory_policy: true,
        power_policy: cfg!(target_os = "macos"),
    };
    let message = json!({
        "type": "inventory.snapshot", "protocolVersion": PROTOCOL_VERSION,
        "revision": snapshot.revision, "capabilities": capabilities, "inventory": snapshot,
    });
    socket
        .send(Message::Text(message.to_string().into()))
        .await?;
    Ok(())
}

fn health_message(
    config: &Config,
    snapshot: &InventorySnapshot,
    stream_count: usize,
    uptime: u64,
) -> Value {
    let roots: BTreeMap<String, String> = config
        .roots
        .iter()
        .map(|(key, path)| (key.clone(), path.to_string_lossy().into_owned()))
        .collect();
    json!({
        "type": "health", "protocolVersion": PROTOCOL_VERSION, "version": VERSION,
        "streamCount": stream_count, "uptimeSec": uptime, "memMb": rss_mb(), "roots": roots,
        "tmux": { "sessions": legacy_tmux(snapshot) },
    })
}

fn legacy_tmux(snapshot: &InventorySnapshot) -> Vec<Value> {
    snapshot.runtimes.iter().find_map(|runtime| match runtime {
        RuntimeInventory::Tmux { sessions, .. } => Some(sessions.iter().map(|session| {
            let tabs = session.spaces.first().map(|space| &space.tabs);
            json!({
                "name": session.name, "path": session.path, "windowCount": tabs.map_or(0, Vec::len),
                "windows": tabs.into_iter().flatten().map(|tab| json!({
                    "index": tab.ordinal, "id": tab.id, "name": tab.name, "target": tab.id,
                    "path": tab.panes.first().and_then(|pane| pane.cwd.clone()),
                    "currentCommand": tab.panes.iter().find(|pane| pane.focused).and_then(|pane| pane.command.clone()),
                })).collect::<Vec<_>>(),
            })
        }).collect()),
        _ => None,
    }).unwrap_or_default()
}

fn rss_mb() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return 0;
    }
    let rss = unsafe { usage.assume_init().ru_maxrss as u64 };
    if cfg!(target_os = "macos") {
        rss / (1024 * 1024)
    } else {
        rss / 1024
    }
}
