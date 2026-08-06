mod cli;
mod config;
mod fs_policy;
mod git;
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
use protocol::{CapabilitySet, Incoming, InventorySnapshot, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};
use terminal::{
    next_terminal_sequence, terminal_checkpoint_flags, terminal_chunk_count, terminal_frame,
    AttachOptions, Outbound, Registry, Target, MAX_TERMINAL_DATA_BYTES,
};
use tokio::{
    sync::{mpsc, Mutex},
    time::{interval, sleep, MissedTickBehavior},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message,
    },
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MIN_RECONNECT: Duration = Duration::from_secs(1);
const MAX_RECONNECT: Duration = Duration::from_secs(30);
// A connection that survived this long was healthy, not a failing retry.
const RECONNECT_RESET_AFTER: Duration = Duration::from_secs(60);

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    if cli::run(VERSION).await? {
        return Ok(());
    }
    let config = Arc::new(Config::load()?);
    eprintln!("[terminalz] starting v{VERSION} (protocol v{PROTOCOL_VERSION})");
    let mut reconnect = MIN_RECONNECT;
    loop {
        let started = Instant::now();
        match run_connection(&config).await {
            Ok(ConnectionEnd::Replaced) => return Ok(()),
            Ok(ConnectionEnd::Shutdown) => return Ok(()),
            Ok(ConnectionEnd::Disconnected) => {}
            Err(err) => eprintln!("[terminalz] connection error: {err:#}"),
        }
        // Back off only against repeated failures. Without this reset a few
        // scattered network blips over a long uptime would permanently pin
        // the agent at the 30s ceiling, so a laptop waking from sleep would
        // sit disconnected far longer than the outage warranted.
        if started.elapsed() >= RECONNECT_RESET_AFTER {
            reconnect = MIN_RECONNECT;
        }
        tokio::select! {
            _ = sleep(jitter(reconnect)) => {}
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
        reconnect = (reconnect * 2).min(MAX_RECONNECT);
    }
}

/// Spreads reconnect storms when a broker restart drops every agent at once.
/// Derived from the process id and monotonic clock rather than a PRNG crate:
/// the agent has no other need for randomness and this only has to decorrelate
/// peers, not resist prediction.
fn jitter(base: Duration) -> Duration {
    let clock = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.subsec_nanos() as u128);
    let entropy = u128::from(std::process::id()).wrapping_mul(2_654_435_761) ^ clock;
    let spread = (base.as_millis() / 2).max(1);
    base.saturating_sub(Duration::from_millis((entropy % spread) as u64))
}

enum ConnectionEnd {
    Replaced,
    Shutdown,
    Disconnected,
}

/// Tokio detaches a task when its JoinHandle is dropped. Connection-owned
/// producers must instead stop with the socket or they keep polling Herdr and
/// can race the replacement connection's initial inventory snapshot.
struct AbortTask(tokio::task::JoinHandle<()>);

impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn run_connection(config: &Arc<Config>) -> Result<ConnectionEnd> {
    let mut request = config.url.clone().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", config.token))?,
    );
    // Tungstenite defaults to two eager 128 KiB buffers and accepts 64 MiB
    // messages. Agent protocol messages are capped at 1 MiB and terminal
    // frames at 240 KiB, so smaller buffers materially reduce idle RSS while
    // preserving bounded backpressure during a broker/network failure.
    let socket_config = WebSocketConfig::default()
        .read_buffer_size(8 * 1024)
        .write_buffer_size(32 * 1024)
        .max_write_buffer_size(1024 * 1024)
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let (mut socket, _) = connect_async_with_config(request, Some(socket_config), false)
        .await
        .context("could not connect to broker")?;
    eprintln!("[terminalz] connected to {}", config.url);
    let started = Instant::now();
    let mut terminal = Registry::new();
    let power = Arc::new(Mutex::new(PowerManager::new()));
    // Requests that shell out (inventory, runtime mutations, directory
    // listing) or block on a Herdr socket run on their own task and report
    // back through this queue. Awaiting them inline stalled terminal output,
    // health, and WebSocket pings for the whole duration on this
    // single-threaded runtime.
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Outbound>(64);
    let mut health_tick = interval(Duration::from_secs(30));
    health_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut ping_tick = interval(Duration::from_secs(30));
    ping_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut driver_lease_tick = interval(Duration::from_secs(15));
    driver_lease_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut power_lease_tick = interval(Duration::from_secs(15));
    power_lease_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // Inventory collection shells out to tmux and talks to the Herdr socket,
    // so it runs on its own task and only emits when the normalized tree moves.
    let _inventory_task = AbortTask(tokio::spawn(run_inventory(
        Arc::clone(config),
        outbound_tx.clone(),
    )));

    loop {
        tokio::select! {
            message = socket.next() => {
                let Some(message) = message else { return Ok(ConnectionEnd::Disconnected); };
                match message? {
                    Message::Text(text) => {
                        let incoming: Incoming = match serde_json::from_str(&text) { Ok(value) => value, Err(_) => continue };
                        if incoming.kind == "hello" { continue; }
                        // Terminal commands only enqueue onto per-target
                        // channels, so they stay inline where they can borrow
                        // the registry. Everything else is spawned.
                        if is_terminal_request(&incoming.kind) {
                            for response in handle_terminal_request(&mut terminal, incoming) {
                                socket.send(Message::Text(response.to_string().into())).await?;
                            }
                        } else {
                            let config = Arc::clone(config);
                            let power = Arc::clone(&power);
                            let responses = outbound_tx.clone();
                            tokio::spawn(async move {
                                for response in handle_request(&config, &power, incoming).await {
                                    if responses.send(Outbound::Json(response)).await.is_err() { break; }
                                }
                            });
                        }
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
                    for message in terminal.handle_event(event) { send_outbound(&mut socket, message).await?; }
                }
            }
            Some(message) = outbound_rx.recv() => send_outbound(&mut socket, message).await?,
            _ = health_tick.tick() => {
                let health = health_message(
                    config,
                    terminal.len(),
                    started.elapsed().as_secs(),
                );
                socket.send(Message::Text(health.to_string().into())).await?;
            }
            _ = ping_tick.tick() => socket.send(Message::Ping(Vec::new().into())).await?,
            _ = driver_lease_tick.tick() => {
                for message in terminal.expire_drivers(Duration::from_secs(5 * 60)) {
                    socket.send(Message::Text(message.to_string().into())).await?;
                }
            }
            _ = power_lease_tick.tick() => {
                let _ = power.lock().await.reap().await;
            }
            _ = tokio::signal::ctrl_c() => {
                let _ = power.lock().await.stop().await;
                let _ = socket.close(None).await;
                return Ok(ConnectionEnd::Shutdown);
            }
        }
    }
}

async fn send_outbound<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    message: Outbound,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match message {
        Outbound::Json(value) => socket.send(Message::Text(value.to_string().into())).await?,
        Outbound::Terminal {
            stream_id,
            first_sequence,
            checkpoint,
            bytes,
        } => {
            let chunk_count = terminal_chunk_count(bytes.len());
            let mut sequence = first_sequence;
            if bytes.is_empty() {
                let flags = terminal_checkpoint_flags(checkpoint, 0, chunk_count);
                socket
                    .send(Message::Binary(
                        terminal_frame(&stream_id, sequence, flags, &[]).into(),
                    ))
                    .await?;
            } else {
                for (index, chunk) in bytes.chunks(MAX_TERMINAL_DATA_BYTES).enumerate() {
                    let flags = terminal_checkpoint_flags(checkpoint, index, chunk_count);
                    socket
                        .send(Message::Binary(
                            terminal_frame(&stream_id, sequence, flags, chunk).into(),
                        ))
                        .await?;
                    sequence = next_terminal_sequence(sequence);
                }
            }
        }
    }
    Ok(())
}

fn is_terminal_request(kind: &str) -> bool {
    matches!(
        kind,
        "terminal-attach"
            | "terminal-input"
            | "terminal-resize"
            | "terminal-claim-drive"
            | "terminal-close"
    )
}

/// Attaches the request/response envelope to a handler's outcome. Requests
/// without a `requestId` are fire-and-forget events (the broker omits it for
/// high-frequency input/resize), so their acknowledgement is simply dropped.
fn respond(request_id: Option<String>, result: Result<(Value, Vec<Value>)>) -> Vec<Value> {
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

fn handle_terminal_request(terminal: &mut Registry, incoming: Incoming) -> Vec<Value> {
    let request_id = incoming.request_id.clone();
    let stream_id = incoming.string("streamId").unwrap_or_default();
    let result = (|| match incoming.kind.as_str() {
        "terminal-attach" => {
            if stream_id.is_empty() {
                anyhow::bail!("streamId is required");
            }
            let target = Target::from_value(incoming.value("runtimeTarget"))?;
            let driver = terminal.attach(
                stream_id,
                target.clone(),
                AttachOptions {
                    cols: incoming.u16("cols", 80),
                    rows: incoming.u16("rows", 24),
                    read_only: incoming.bool("readOnly"),
                    request_checkpoint: incoming.bool("requestCheckpoint"),
                    checkpoint_history_lines: incoming.u16("checkpointHistoryLines", 2000),
                    checkpoint_max_bytes: incoming.u32("checkpointMaxBytes", 1024 * 1024) as usize,
                },
            )?;
            Ok((
                json!({
                    "runtime": target.runtime,
                    "externalId": target.external_id,
                }),
                driver,
            ))
        }
        "terminal-input" => {
            let data = incoming.string("data").unwrap_or_default().into_bytes();
            if data.len() > 256 * 1024 {
                anyhow::bail!("terminal input exceeded 256 KiB");
            }
            let driver_updates = terminal.input(&stream_id, data)?;
            Ok((json!({ "ok": true }), driver_updates))
        }
        "terminal-resize" => {
            terminal.resize(
                &stream_id,
                incoming.u16("cols", 80),
                incoming.u16("rows", 24),
            );
            Ok((json!({ "ok": true }), Vec::new()))
        }
        "terminal-claim-drive" => Ok((json!({ "ok": true }), terminal.claim(&stream_id))),
        "terminal-close" => {
            terminal.close(&stream_id);
            Ok((json!({ "ok": true }), Vec::new()))
        }
        _ => anyhow::bail!("unknown terminal command: {}", incoming.kind),
    })();
    respond(request_id, result)
}

async fn handle_request(
    config: &Config,
    power: &Mutex<PowerManager>,
    incoming: Incoming,
) -> Vec<Value> {
    let request_id = incoming.request_id.clone();
    let result = async {
        match incoming.kind.as_str() {
            "list-directory" => {
                let root = incoming.string("rootKey").context("rootKey is required")?;
                let relative = incoming.string("relativePath").unwrap_or_default();
                let listing = fs_policy::list_directory(config, &root, &relative)?;
                Ok((serde_json::to_value(listing)?, Vec::new()))
            }
            kind if kind.starts_with("git.") => {
                let cwd = request_cwd(config, &incoming)?;
                Ok((git::execute(kind, &cwd, &incoming).await?, Vec::new()))
            }
            kind if kind.starts_with("power.") => handle_power_request(power, &incoming).await,
            kind if kind.starts_with("runtime.") => handle_runtime_request(config, &incoming).await,
            _ => anyhow::bail!("unknown command: {}", incoming.kind),
        }
    }
    .await;
    respond(request_id, result)
}

async fn handle_power_request(
    power: &Mutex<PowerManager>,
    incoming: &Incoming,
) -> Result<(Value, Vec<Value>)> {
    let mode = incoming
        .string("mode")
        .as_deref()
        .and_then(PowerMode::parse)
        .unwrap_or(PowerMode::TerminalsAwake);
    let duration = incoming
        .value("durationMs")
        .and_then(Value::as_u64)
        .map(Duration::from_millis);
    let mut power = power.lock().await;
    let state = match incoming.kind.as_str() {
        "power.acquire" | "power.renew" => {
            let lease_id = incoming.string("leaseId").context("leaseId is required")?;
            power.acquire(&lease_id, mode, duration).await?
        }
        "power.release" => {
            let lease_id = incoming.string("leaseId").context("leaseId is required")?;
            power.release(&lease_id).await?
        }
        "power.get" => return Ok((json!({ "state": power.reap().await? }), Vec::new())),
        kind => anyhow::bail!("unknown power command: {kind}"),
    };
    Ok((json!({ "success": true, "state": state }), Vec::new()))
}

async fn handle_runtime_request(
    config: &Config,
    incoming: &Incoming,
) -> Result<(Value, Vec<Value>)> {
    // Herdr addresses its own session; tmux is a single global server.
    let session = || {
        incoming
            .string("runtimeSessionId")
            .context("runtimeSessionId is required")
    };
    let runtime = incoming.string("runtime").context("runtime is required")?;
    if runtime != "herdr" && runtime != "tmux" {
        anyhow::bail!("runtime must be herdr or tmux");
    }
    let is_herdr = runtime == "herdr";
    let is_tmux = runtime == "tmux";
    let name = || incoming.string("name").context("name is required");
    let tab_id = || incoming.string("tabId").context("tabId is required");
    let pane_id = || incoming.string("paneId").context("paneId is required");
    let space_id = || incoming.string("spaceId").context("spaceId is required");

    match incoming.kind.as_str() {
        "runtime.create-session" => {
            let cwd = request_cwd(config, incoming)?;
            if is_herdr {
                herdr::mutate(
                    &session()?,
                    "workspace.create",
                    json!({ "cwd": cwd, "label": name()?, "focus": false, "env": {} }),
                )
                .await?;
            } else {
                tmux::create_session(&name()?, std::path::Path::new(&cwd)).await?;
            }
        }
        "runtime.create-space" => {
            if !is_herdr {
                anyhow::bail!("spaces are only supported for Herdr");
            }
            let cwd = request_cwd(config, incoming)?;
            herdr::mutate(
                &session()?,
                "workspace.create",
                json!({ "cwd": cwd, "label": incoming.string("name"), "focus": false, "env": {} }),
            )
            .await?;
        }
        "runtime.create-tab" => {
            let cwd = request_cwd(config, incoming)?;
            if is_herdr {
                herdr::mutate(
                    &session()?,
                    "tab.create",
                    json!({
                        "workspace_id": incoming.string("spaceId"),
                        "cwd": cwd,
                        "label": incoming.string("name"),
                        "focus": false,
                        "env": {},
                    }),
                )
                .await?;
            } else {
                tmux::create_tab(
                    &incoming
                        .string("runtimeSessionId")
                        .context("runtimeSessionId is required")?,
                    &incoming
                        .string("name")
                        .unwrap_or_else(|| "shell".to_owned()),
                    std::path::Path::new(&cwd),
                )
                .await?;
            }
        }
        "runtime.rename-space" => {
            if is_tmux {
                tmux::rename_session(
                    &incoming
                        .string("runtimeSessionId")
                        .context("runtimeSessionId is required")?,
                    &name()?,
                )
                .await?;
            } else {
                herdr::mutate(
                    &session()?,
                    "workspace.rename",
                    json!({ "workspace_id": space_id()?, "label": name()? }),
                )
                .await?;
            }
        }
        "runtime.rename-tab" => {
            if is_herdr {
                herdr::mutate(
                    &session()?,
                    "tab.rename",
                    json!({ "tab_id": tab_id()?, "label": name()? }),
                )
                .await?;
            } else {
                tmux::rename_tab(&tab_id()?, &name()?).await?;
            }
        }
        "runtime.rename-pane" => {
            if !is_herdr {
                anyhow::bail!("pane rename is only supported for Herdr");
            }
            herdr::mutate(
                &session()?,
                "pane.rename",
                json!({ "pane_id": pane_id()?, "label": name()? }),
            )
            .await?;
        }
        "runtime.close-tab" => {
            if is_herdr {
                herdr::mutate(&session()?, "tab.close", json!({ "tab_id": tab_id()? })).await?;
            } else {
                tmux::close_tab(&tab_id()?).await?;
            }
        }
        "runtime.close-pane" => {
            if is_tmux {
                tmux::close_pane(&pane_id()?).await?;
            } else {
                herdr::mutate(&session()?, "pane.close", json!({ "pane_id": pane_id()? })).await?;
            }
        }
        "runtime.close-space" => {
            if !is_herdr {
                anyhow::bail!("spaces are only supported for Herdr");
            }
            herdr::mutate(
                &session()?,
                "workspace.close",
                json!({ "workspace_id": space_id()? }),
            )
            .await?;
        }
        "runtime.close-session" => {
            if !is_tmux {
                anyhow::bail!("runtime sessions can only be closed for tmux");
            }
            tmux::close_session(&session()?).await?;
        }
        kind => anyhow::bail!("unknown command: {kind}"),
    }
    Ok((json!({ "ok": true }), Vec::new()))
}

fn request_cwd(config: &Config, incoming: &Incoming) -> Result<String> {
    let root = incoming.string("rootKey");
    let relative = incoming.string("relativePath").unwrap_or_default();
    Ok(
        fs_policy::resolve_creation_path(config, root.as_deref(), &relative)?
            .to_string_lossy()
            .into_owned(),
    )
}

/// Owns inventory collection for the life of one broker connection. Emits a
/// snapshot immediately, then on Herdr events, a tmux poll, and a periodic
/// full sweep.
async fn run_inventory(config: Arc<Config>, outbound: mpsc::Sender<Outbound>) {
    const IDLE_CEILING: Duration = Duration::from_secs(60);
    let mut collector = inventory::Collector::new();
    let snapshot = collector.initialize(&config).await;
    if outbound
        .send(Outbound::Json(inventory_message(&snapshot)))
        .await
        .is_err()
    {
        return;
    }

    // Subscribe only after the authoritative first snapshot is on the wire.
    // Starting subscriptions concurrently made a reconnect open several
    // Herdr snapshot/event sockets before the broker had any usable target.
    let mut herdr_events = herdr::spawn_event_watchers();

    let base = Duration::from_millis(config.inventory_interval_ms);
    let mut poll_delay = base;
    let mut safety_tick = interval(IDLE_CEILING);
    safety_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    safety_tick.tick().await;

    loop {
        let changed = tokio::select! {
            _ = sleep(poll_delay) => collector.refresh_tmux(&config).await,
            event = herdr_events.recv() => {
                if event.is_none() { return; }
                // Coalesce the burst a single user action produces.
                while herdr_events.try_recv().is_ok() {}
                collector.refresh_herdr(&config).await
            }
            _ = safety_tick.tick() => collector.refresh_all(&config).await,
        };
        match changed {
            Some(snapshot) => {
                poll_delay = base;
                if outbound
                    .send(Outbound::Json(inventory_message(&snapshot)))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            // Nothing moved locally. Ease off so an idle machine stops
            // spawning `tmux list-panes` every few seconds; the safety sweep
            // still bounds staleness and Herdr pushes its own events, so the
            // first real change snaps the interval back to the configured
            // rate.
            None => poll_delay = (poll_delay * 2).min(IDLE_CEILING),
        }
    }
}

fn inventory_message(snapshot: &InventorySnapshot) -> Value {
    let capabilities = CapabilitySet {
        inventory_snapshots: true,
        typed_mutations: true,
        shared_terminal_streams: true,
        herdr: inventory::runtime_available(snapshot, "herdr"),
        tmux: inventory::runtime_available(snapshot, "tmux"),
        directory_policy: true,
        power_policy: cfg!(target_os = "macos"),
        git_operations: true,
    };
    json!({
        "type": "inventory.snapshot", "protocolVersion": PROTOCOL_VERSION,
        "revision": snapshot.revision, "capabilities": capabilities, "inventory": snapshot,
    })
}

fn health_message(config: &Config, stream_count: usize, uptime: u64) -> Value {
    let roots: BTreeMap<String, String> = config
        .roots
        .iter()
        .map(|(key, path)| (key.clone(), path.to_string_lossy().into_owned()))
        .collect();
    json!({
        "type": "health", "protocolVersion": PROTOCOL_VERSION, "version": VERSION,
        "streamCount": stream_count, "uptimeSec": uptime,
        "memMb": current_rss_mb(), "memPeakMb": peak_rss_mb(), "roots": roots,
    })
}

fn peak_rss_mb() -> u64 {
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

#[cfg(target_os = "macos")]
fn current_rss_mb() -> u64 {
    #[repr(C)]
    #[derive(Default)]
    struct ProcTaskInfo {
        virtual_size: u64,
        resident_size: u64,
        total_user: u64,
        total_system: u64,
        threads_user: u64,
        threads_system: u64,
        policy: i32,
        faults: i32,
        pageins: i32,
        cow_faults: i32,
        messages_sent: i32,
        messages_received: i32,
        syscalls_mach: i32,
        syscalls_unix: i32,
        context_switches: i32,
        thread_count: i32,
        running_threads: i32,
        priority: i32,
    }
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut libc::c_void,
            buffer_size: i32,
        ) -> i32;
    }
    const PROC_PIDTASKINFO: i32 = 4;
    let mut info = ProcTaskInfo::default();
    let size = std::mem::size_of::<ProcTaskInfo>() as i32;
    let read = unsafe {
        proc_pidinfo(
            std::process::id() as i32,
            PROC_PIDTASKINFO,
            0,
            (&mut info as *mut ProcTaskInfo).cast(),
            size,
        )
    };
    if read == size {
        info.resident_size / (1024 * 1024)
    } else {
        peak_rss_mb()
    }
}

#[cfg(target_os = "linux")]
fn current_rss_mb() -> u64 {
    let pages = std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|value| value.split_whitespace().nth(1)?.parse::<u64>().ok())
        .unwrap_or(0);
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(0) as u64;
    pages.saturating_mul(page_size) / (1024 * 1024)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn current_rss_mb() -> u64 {
    peak_rss_mb()
}
