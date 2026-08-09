use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::mpsc,
    time::{interval, timeout, Interval, MissedTickBehavior},
};
use unicode_width::UnicodeWidthStr;

static TMUX_CONTROL_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const DEFAULT_CHECKPOINT_HISTORY_LINES: u16 = 2000;
const DEFAULT_CHECKPOINT_MAX_BYTES: usize = 1024 * 1024;
const MIN_CHECKPOINT_HISTORY_LINES: u16 = 100;
const MIN_CHECKPOINT_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy)]
struct CheckpointPolicy {
    history_lines: u16,
    max_bytes: usize,
}

impl CheckpointPolicy {
    fn new(history_lines: u16, max_bytes: usize) -> Self {
        Self {
            history_lines: history_lines.clamp(
                MIN_CHECKPOINT_HISTORY_LINES,
                DEFAULT_CHECKPOINT_HISTORY_LINES,
            ),
            max_bytes: max_bytes.clamp(MIN_CHECKPOINT_MAX_BYTES, DEFAULT_CHECKPOINT_MAX_BYTES),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Target {
    pub runtime: String,
    pub runtime_session_id: String,
    pub pane_id: String,
    pub external_id: String,
    pub cwd: Option<String>,
    // Herdr renders a virtual screen for the requested dimensions. Keep each
    // browser viewer distinct so phone and desktop wrapping never share one
    // observer. tmux remains shared because control mode is raw pane output.
    viewer_id: Option<String>,
}

impl Target {
    pub fn from_value(value: Option<&Value>) -> Result<Self> {
        let raw = value
            .and_then(Value::as_object)
            .context("runtimeTarget is required")?;
        let runtime = raw
            .get("runtime")
            .and_then(Value::as_str)
            .context("runtimeTarget.runtime is required")?
            .to_owned();
        if runtime != "herdr" && runtime != "tmux" {
            bail!("runtimeTarget.runtime must be herdr or tmux");
        }
        let runtime_session_id = raw
            .get("runtimeSessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .context("runtimeTarget.runtimeSessionId is required")?;
        let pane_id = raw
            .get("paneId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .context("runtimeTarget.paneId is required")?;
        let external_id = raw
            .get("terminalId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| pane_id.clone());
        if runtime_session_id.is_empty()
            || pane_id.is_empty()
            || external_id.is_empty()
            || runtime_session_id.len() > 512
            || pane_id.len() > 512
            || external_id.len() > 512
        {
            bail!("runtime target is incomplete");
        }
        Ok(Self {
            runtime,
            runtime_session_id,
            pane_id,
            external_id,
            cwd: raw
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            viewer_id: None,
        })
    }
}

#[derive(Debug)]
enum StreamCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
    TakeControl,
    ReleaseControl,
    Checkpoint(CheckpointPolicy),
    Stop,
}

#[derive(Debug)]
pub struct StreamEvent {
    target: Target,
    generation: u64,
    kind: StreamEventKind,
}

#[derive(Debug)]
enum StreamEventKind {
    Data { bytes: Vec<u8>, full: bool },
    Gap,
    Exit,
}

/// Binds a runtime task to the exact `SharedStream` that spawned it. A task
/// briefly outlives its registry entry when the last viewer detaches, so a
/// detach immediately followed by a re-attach to the same target leaves a
/// stale `Exit` queued. Without this tag that `Exit` tears down the freshly
/// created stream and the reconnecting browser sees a dead terminal.
#[derive(Clone)]
struct EventSink {
    events: mpsc::Sender<StreamEvent>,
    target: Target,
    generation: u64,
}

impl EventSink {
    fn target(&self) -> &Target {
        &self.target
    }

    fn wrap(&self, kind: StreamEventKind) -> StreamEvent {
        StreamEvent {
            target: self.target.clone(),
            generation: self.generation,
            kind,
        }
    }

    fn try_send(&self, kind: StreamEventKind) -> bool {
        self.events.try_send(self.wrap(kind)).is_ok()
    }

    async fn send(&self, kind: StreamEventKind) {
        let _ = self.events.send(self.wrap(kind)).await;
    }
}

pub enum Outbound {
    Json(Value),
    Terminal {
        stream_id: String,
        first_sequence: u32,
        checkpoint: bool,
        bytes: Vec<u8>,
    },
}

pub struct AttachOptions {
    pub cols: u16,
    pub rows: u16,
    pub read_only: bool,
    pub request_checkpoint: bool,
    pub checkpoint_history_lines: u16,
    pub checkpoint_max_bytes: usize,
}

pub const MAX_TERMINAL_DATA_BYTES: usize = 240 * 1024;

// A runtime task stops polling its command queue while it captures a
// checkpoint (bounded at 5s). Size the queue so an ordinary paste still fits
// in that window rather than being rejected as backpressure.
const COMMAND_QUEUE_DEPTH: usize = 64;
const EVENT_QUEUE_DEPTH: usize = 16;
const MAX_HERDR_FRAME_BYTES: usize = 2 * 1024 * 1024;

pub fn next_terminal_sequence(sequence: u32) -> u32 {
    sequence.wrapping_add(1).max(1)
}

pub fn terminal_chunk_count(byte_count: usize) -> usize {
    byte_count.max(1).div_ceil(MAX_TERMINAL_DATA_BYTES)
}

pub fn terminal_checkpoint_flags(checkpoint: bool, index: usize, chunk_count: usize) -> u8 {
    if !checkpoint {
        return 0;
    }
    u8::from(index == 0)
        | if index > 0 { 1 << 1 } else { 0 }
        | if index + 1 == chunk_count { 1 << 2 } else { 0 }
}

#[derive(Debug)]
struct Subscriber {
    read_only: bool,
    cols: u16,
    rows: u16,
    last_input: Instant,
}

struct SharedStream {
    tx: mpsc::Sender<StreamCommand>,
    subscribers: HashMap<String, Subscriber>,
    driver: Option<String>,
    // The stream id every binary frame for this target is tagged with. The
    // broker resolves it to a session and fans the bytes out to all viewers,
    // so it must stay put while its subscriber is attached: re-picking an
    // arbitrary `subscribers` key per event can name a viewer the broker has
    // already dropped, and the broker discards those frames for *everyone*.
    anchor: String,
    generation: u64,
    cols: u16,
    rows: u16,
    sequence: u32,
    saw_output: bool,
}

pub struct Registry {
    targets: HashMap<Target, SharedStream>,
    by_stream: HashMap<String, Target>,
    event_tx: mpsc::Sender<StreamEvent>,
    event_rx: mpsc::Receiver<StreamEvent>,
    next_generation: u64,
}

impl Registry {
    pub fn new() -> Self {
        // PTY readers await this bounded queue, allowing the kernel/runtime
        // socket to provide natural backpressure instead of retaining a large
        // burst per active terminal in the daemon heap.
        let (event_tx, event_rx) = mpsc::channel(EVENT_QUEUE_DEPTH);
        Self {
            targets: HashMap::new(),
            by_stream: HashMap::new(),
            event_tx,
            event_rx,
            next_generation: 0,
        }
    }

    // Every method below is deliberately synchronous. The registry only ever
    // hands work to per-target tasks over bounded queues, so an unresponsive
    // runtime must never be able to stall the connection's select loop (which
    // also drives terminal output, health, and WebSocket pings).
    pub fn attach(
        &mut self,
        stream_id: String,
        mut target: Target,
        options: AttachOptions,
    ) -> Result<Vec<Value>> {
        self.close(&stream_id);
        if target.runtime == "herdr" {
            target.viewer_id = Some(stream_id.clone());
        }
        let already_streaming = self.targets.contains_key(&target);
        let checkpoint_policy = CheckpointPolicy::new(
            options.checkpoint_history_lines,
            options.checkpoint_max_bytes,
        );
        let cols = options.cols;
        let rows = options.rows;
        if !already_streaming {
            let (tx, rx) = mpsc::channel(COMMAND_QUEUE_DEPTH);
            self.next_generation += 1;
            let sink = EventSink {
                events: self.event_tx.clone(),
                target: target.clone(),
                generation: self.next_generation,
            };
            let spawn_sink = sink.clone();
            tokio::spawn(async move {
                let result = if spawn_sink.target().runtime == "herdr" {
                    run_herdr(spawn_sink.clone(), cols, rows, rx).await
                } else {
                    run_tmux(spawn_sink.clone(), cols, rows, checkpoint_policy, rx).await
                };
                if result.is_err() {
                    spawn_sink.send(StreamEventKind::Exit).await;
                }
            });
            self.targets.insert(
                target.clone(),
                SharedStream {
                    tx,
                    subscribers: HashMap::new(),
                    driver: None,
                    anchor: stream_id.clone(),
                    generation: sink.generation,
                    cols,
                    rows,
                    sequence: 0,
                    saw_output: false,
                },
            );
        }
        let shared = self.targets.get_mut(&target).expect("inserted above");
        shared.subscribers.insert(
            stream_id.clone(),
            Subscriber {
                read_only: options.read_only,
                cols,
                rows,
                last_input: Instant::now() - Duration::from_secs(60),
            },
        );
        if !shared.subscribers.contains_key(&shared.anchor) {
            shared.anchor = stream_id.clone();
        }
        self.by_stream.insert(stream_id.clone(), target.clone());
        if already_streaming && options.request_checkpoint {
            let _ = shared
                .tx
                .try_send(StreamCommand::Checkpoint(checkpoint_policy));
        }
        self.resize_target(&target);
        Ok(self.driver_messages(&target))
    }

    pub fn input(&mut self, stream_id: &str, data: Vec<u8>) -> Result<Vec<Value>> {
        let Some(target) = self.by_stream.get(stream_id).cloned() else {
            return Ok(Vec::new());
        };
        let Some(shared) = self.targets.get_mut(&target) else {
            return Ok(Vec::new());
        };
        if shared
            .subscribers
            .get(stream_id)
            .is_none_or(|subscriber| subscriber.read_only)
        {
            return Ok(Vec::new());
        }
        let driver_changed = shared.driver.as_deref() != Some(stream_id);
        if driver_changed {
            shared.driver = Some(stream_id.to_owned());
            if let Some(subscriber) = shared.subscribers.get(stream_id) {
                shared.cols = subscriber.cols;
                shared.rows = subscriber.rows;
            }
            if target.runtime == "herdr" {
                let _ = shared.tx.try_send(StreamCommand::TakeControl);
            } else {
                let _ = shared
                    .tx
                    .try_send(StreamCommand::Resize(shared.cols, shared.rows));
            }
        }
        if let Some(subscriber) = shared.subscribers.get_mut(stream_id) {
            subscriber.last_input = Instant::now();
        }
        // A full queue means the runtime task has not drained a deep buffer,
        // which in practice only happens while it is blocked mid-checkpoint.
        // Report it instead of awaiting: silently reordering the keystroke
        // behind later input would be worse than an explicit failure.
        if shared.tx.try_send(StreamCommand::Input(data)).is_err() {
            bail!("terminal is not accepting input right now");
        }
        Ok(if driver_changed {
            self.driver_messages(&target)
        } else {
            Vec::new()
        })
    }

    pub fn resize(&mut self, stream_id: &str, cols: u16, rows: u16) {
        let Some(target) = self.by_stream.get(stream_id).cloned() else {
            return;
        };
        if let Some(subscriber) = self
            .targets
            .get_mut(&target)
            .and_then(|stream| stream.subscribers.get_mut(stream_id))
        {
            subscriber.cols = cols;
            subscriber.rows = rows;
        }
        self.resize_target(&target);
    }

    pub fn claim(&mut self, stream_id: &str) -> Vec<Value> {
        let Some(target) = self.by_stream.get(stream_id).cloned() else {
            return Vec::new();
        };
        let Some(shared) = self.targets.get_mut(&target) else {
            return Vec::new();
        };
        if shared
            .subscribers
            .get(stream_id)
            .is_some_and(|sub| sub.read_only)
        {
            return Vec::new();
        }
        if shared.driver.as_deref() == Some(stream_id) {
            if let Some(subscriber) = shared.subscribers.get_mut(stream_id) {
                subscriber.last_input = Instant::now();
            }
            return Vec::new();
        }
        shared.driver = Some(stream_id.to_owned());
        if let Some(subscriber) = shared.subscribers.get_mut(stream_id) {
            shared.cols = subscriber.cols;
            shared.rows = subscriber.rows;
            subscriber.last_input = Instant::now();
        }
        let _ = shared
            .tx
            .try_send(StreamCommand::Resize(shared.cols, shared.rows));
        if target.runtime == "herdr" {
            let _ = shared.tx.try_send(StreamCommand::TakeControl);
        }
        self.driver_messages(&target)
    }

    pub fn release(&mut self, stream_id: &str) -> Vec<Value> {
        let Some(target) = self.by_stream.get(stream_id).cloned() else {
            return Vec::new();
        };
        let Some(shared) = self.targets.get_mut(&target) else {
            return Vec::new();
        };
        if shared.driver.as_deref() != Some(stream_id) {
            return Vec::new();
        }
        shared.driver = None;
        if target.runtime == "herdr" {
            let _ = shared.tx.try_send(StreamCommand::ReleaseControl);
        }
        self.driver_messages(&target)
    }

    pub fn close(&mut self, stream_id: &str) {
        let Some(target) = self.by_stream.remove(stream_id) else {
            return;
        };
        let mut stop = false;
        if let Some(shared) = self.targets.get_mut(&target) {
            shared.subscribers.remove(stream_id);
            if shared.driver.as_deref() == Some(stream_id) {
                shared.driver = None;
                if target.runtime == "herdr" && !shared.subscribers.is_empty() {
                    let _ = shared.tx.try_send(StreamCommand::ReleaseControl);
                }
            }
            if shared.anchor == stream_id {
                if let Some(next) = shared.subscribers.keys().next().cloned() {
                    shared.anchor = next;
                }
            }
            stop = shared.subscribers.is_empty();
        }
        if stop {
            // Dropping the SharedStream closes the command channel, which the
            // runtime task treats exactly like an explicit Stop. Removing the
            // entry is therefore sufficient even if the queue is saturated.
            if let Some(shared) = self.targets.remove(&target) {
                let _ = shared.tx.try_send(StreamCommand::Stop);
            }
        } else {
            self.resize_target(&target);
        }
    }

    pub async fn next_event(&mut self) -> Option<StreamEvent> {
        self.event_rx.recv().await
    }

    pub fn handle_event(&mut self, event: StreamEvent) -> Vec<Outbound> {
        let StreamEvent {
            target,
            generation,
            kind,
        } = event;
        // Drop anything emitted by a task whose registry entry has already
        // been replaced. Its Exit would otherwise close the terminal that just
        // re-attached to the same pane.
        if self
            .targets
            .get(&target)
            .is_none_or(|shared| shared.generation != generation)
        {
            return Vec::new();
        }
        match kind {
            StreamEventKind::Data { bytes, full } => {
                let Some(shared) = self.targets.get_mut(&target) else {
                    return Vec::new();
                };
                if !shared.subscribers.contains_key(&shared.anchor) {
                    return Vec::new();
                }
                let stream_id = &shared.anchor;
                let checkpoint = full || !shared.saw_output;
                shared.saw_output = true;
                let first_sequence = next_terminal_sequence(shared.sequence);
                for _ in 0..terminal_chunk_count(bytes.len()) {
                    shared.sequence = next_terminal_sequence(shared.sequence);
                }
                // Keep the source allocation intact and encode one WebSocket
                // chunk at a time in send_outbound. Building every framed
                // copy here briefly doubled RSS for large tmux checkpoints.
                vec![Outbound::Terminal {
                    stream_id: stream_id.clone(),
                    first_sequence,
                    checkpoint,
                    bytes,
                }]
            }
            StreamEventKind::Gap => {
                let Some(shared) = self.targets.get(&target) else {
                    return Vec::new();
                };
                shared
                    .subscribers
                    .keys()
                    .map(|stream_id| {
                        Outbound::Json(json!({ "type": "terminal-gap", "streamId": stream_id }))
                    })
                    .collect()
            }
            StreamEventKind::Exit => {
                let Some(shared) = self.targets.remove(&target) else {
                    return Vec::new();
                };
                for stream_id in shared.subscribers.keys() {
                    self.by_stream.remove(stream_id);
                }
                shared
                    .subscribers
                    .keys()
                    .map(|stream_id| {
                        Outbound::Json(json!({ "type": "terminal-exit", "streamId": stream_id }))
                    })
                    .collect()
            }
        }
    }

    pub fn len(&self) -> usize {
        self.by_stream.len()
    }

    fn resize_target(&self, target: &Target) {
        let Some(shared) = self.targets.get(target) else {
            return;
        };
        // Observers do not resize the shared runtime. The explicit driver is
        // authoritative; without one, retain the size chosen when the shared
        // stream was created. This prevents a phone observer from shrinking
        // every other viewer (and the local runtime controller).
        let (cols, rows) = shared
            .driver
            .as_ref()
            .and_then(|id| shared.subscribers.get(id))
            .map(|subscriber| (subscriber.cols, subscriber.rows))
            .unwrap_or((shared.cols, shared.rows));
        let _ = shared.tx.try_send(StreamCommand::Resize(
            cols.clamp(20, 500),
            rows.clamp(5, 200),
        ));
    }

    pub fn expire_drivers(&mut self, max_idle: Duration) -> Vec<Value> {
        let mut changed = Vec::new();
        let targets = self.targets.keys().cloned().collect::<Vec<_>>();
        for target in targets {
            let Some(shared) = self.targets.get_mut(&target) else {
                continue;
            };
            let expired = shared
                .driver
                .as_ref()
                .and_then(|id| shared.subscribers.get(id))
                .is_some_and(|subscriber| subscriber.last_input.elapsed() >= max_idle);
            if !expired {
                continue;
            }
            shared.driver = None;
            if target.runtime == "herdr" {
                let _ = shared.tx.try_send(StreamCommand::ReleaseControl);
            }
            changed.extend(self.driver_messages(&target));
        }
        changed
    }

    fn driver_messages(&self, target: &Target) -> Vec<Value> {
        self.targets.get(target).map(|shared| shared.subscribers.iter().map(|(id, subscriber)| json!({
            "type": "driver-changed", "streamId": id, "driver": shared.driver.as_deref() == Some(id), "readOnly": subscriber.read_only,
        })).collect()).unwrap_or_default()
    }
}

pub fn terminal_frame(stream_id: &str, sequence: u32, flags: u8, data: &[u8]) -> Vec<u8> {
    let stream_id = stream_id.as_bytes();
    let stream_id_len = stream_id.len().min(u16::MAX as usize);
    let mut frame = Vec::with_capacity(11 + stream_id_len + data.len());
    frame.extend_from_slice(b"TMG2");
    frame.push(flags);
    frame.extend_from_slice(&sequence.to_be_bytes());
    frame.extend_from_slice(&(stream_id_len as u16).to_be_bytes());
    frame.extend_from_slice(&stream_id[..stream_id_len]);
    frame.extend_from_slice(data);
    frame
}

async fn run_tmux(
    sink: EventSink,
    _cols: u16,
    _rows: u16,
    initial_checkpoint_policy: CheckpointPolicy,
    mut rx: mpsc::Receiver<StreamCommand>,
) -> Result<()> {
    let target = sink.target().clone();
    let tmux_session = target.runtime_session_id.clone();
    let (pane_id, session_panes) = tmux_target(&target, &tmux_session).await?;

    // A normal tmux client can isolate its current window with a grouped
    // session, but the active pane belongs to the shared window. Use control
    // mode instead: it observes one pane's byte stream and targets input by
    // stable pane ID without ever selecting or resizing the local UI.
    let mut command = Command::new("tmux");
    command.args([
        "-C",
        "attach-session",
        "-f",
        "ignore-size",
        "-t",
        &tmux_session,
    ]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .context("could not start tmux control client")?;
    let mut stdin = child.stdin.take().context("tmux control has no stdin")?;
    let stdout = child.stdout.take().context("tmux control has no stdout")?;
    let mut reader = BufReader::with_capacity(32 * 1024, stdout);

    disable_unrelated_tmux_panes(&mut stdin, &pane_id, &session_panes).await?;
    let mut output_gap = false;
    let mut gap_tick = gap_retry_interval();
    let checkpoint = timeout(
        Duration::from_secs(5),
        capture_tmux_control_checkpoint(
            &mut stdin,
            &mut reader,
            &pane_id,
            false,
            &sink,
            &mut output_gap,
            initial_checkpoint_policy,
        ),
    )
    .await
    .context("tmux checkpoint timed out")??;
    emit_terminal_data(&sink, &mut output_gap, checkpoint, true);

    let mut line = Vec::with_capacity(32 * 1024);
    loop {
        tokio::select! {
            read = read_tmux_control_line(&mut reader, &mut line) => {
                if !read? || line.starts_with(b"%exit") {
                    break;
                }
                if let Some(bytes) = tmux_control_output(&line, &pane_id) {
                    emit_terminal_data(&sink, &mut output_gap, bytes, false);
                }
            }
            command = rx.recv() => match command {
                Some(StreamCommand::Input(data)) => send_tmux_input(&mut stdin, &pane_id, &data).await?,
                // Resizing a shared tmux window would also resize the terminal
                // on the physical machine. The remote xterm adapts to the
                // pane's existing dimensions instead.
                Some(StreamCommand::Resize(_, _)) => {},
                Some(StreamCommand::TakeControl) => {},
                Some(StreamCommand::ReleaseControl) => {},
                Some(StreamCommand::Checkpoint(checkpoint_policy)) => {
                    let checkpoint = timeout(
                        Duration::from_secs(5),
                        capture_tmux_control_checkpoint(
                            &mut stdin,
                            &mut reader,
                            &pane_id,
                            true,
                            &sink,
                            &mut output_gap,
                            checkpoint_policy,
                        ),
                    ).await.context("tmux checkpoint timed out")??;
                    emit_terminal_data(&sink, &mut output_gap, checkpoint, true);
                }
                Some(StreamCommand::Stop) | None => { let _ = child.start_kill(); break; }
            },
            _ = gap_tick.tick(), if output_gap => retry_terminal_gap(&sink, &mut output_gap),
            _ = child.wait() => break,
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
    sink.send(StreamEventKind::Exit).await;
    Ok(())
}

async fn tmux_target(target: &Target, session: &str) -> Result<(String, Vec<String>)> {
    let output = Command::new("tmux")
        .args(["list-panes", "-s", "-t", session, "-F", "#{pane_id}"])
        .output()
        .await?;
    if !output.status.success() {
        bail!(
            "could not list tmux session {session}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let panes = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|pane| valid_tmux_pane_id(pane))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let pane_id = if valid_tmux_pane_id(&target.external_id) {
        target.external_id.clone()
    } else {
        let resolved = Command::new("tmux")
            .args(["display-message", "-p", "-t", session, "#{pane_id}"])
            .output()
            .await?;
        let pane = String::from_utf8_lossy(&resolved.stdout).trim().to_owned();
        if !resolved.status.success() || !valid_tmux_pane_id(&pane) {
            bail!("could not resolve active pane for tmux session {session}");
        }
        pane
    };
    if !panes.iter().any(|pane| pane == &pane_id) {
        bail!("tmux pane {pane_id} is not linked to session {session}");
    }
    Ok((pane_id, panes))
}

fn valid_tmux_pane_id(value: &str) -> bool {
    value
        .strip_prefix('%')
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
}

async fn disable_unrelated_tmux_panes(
    stdin: &mut ChildStdin,
    target: &str,
    panes: &[String],
) -> Result<()> {
    let mut command = Vec::with_capacity(16 + 64 * 16);
    let mut count = 0;
    for pane in panes.iter().filter(|pane| pane.as_str() != target) {
        if count == 0 {
            command.extend_from_slice(b"refresh-client");
        }
        command.extend_from_slice(b" -A '");
        command.extend_from_slice(pane.as_bytes());
        command.extend_from_slice(b":off'");
        count += 1;
        if count == 64 {
            command.push(b'\n');
            stdin.write_all(&command).await?;
            command.clear();
            count = 0;
        }
    }
    if count != 0 {
        command.push(b'\n');
        stdin.write_all(&command).await?;
    }
    stdin.flush().await?;
    Ok(())
}

async fn capture_tmux_control_checkpoint(
    stdin: &mut ChildStdin,
    reader: &mut BufReader<ChildStdout>,
    pane_id: &str,
    forward_prior_output: bool,
    sink: &EventSink,
    output_gap: &mut bool,
    policy: CheckpointPolicy,
) -> Result<Vec<u8>> {
    let marker = format!(
        "TERMINALZ_CHECKPOINT_{}_{}",
        std::process::id(),
        TMUX_CONTROL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    stdin
        .write_all(format!("display-message -p {marker}\n").as_bytes())
        .await?;
    stdin
        .write_all(
            format!(
                "capture-pane -p -e -J -S -{} -t {pane_id}\n",
                policy.history_lines
            )
            .as_bytes(),
        )
        .await?;
    stdin.flush().await?;

    const CHECKPOINT_TRIM_SLOP: usize = 64 * 1024;
    let mut line = Vec::with_capacity(32 * 1024);
    let mut active_guard: Option<Vec<u8>> = None;
    let mut marker_guard: Option<Vec<u8>> = None;
    let mut capture_guard: Option<Vec<u8>> = None;
    let mut checkpoint = Vec::with_capacity(64 * 1024);
    checkpoint.extend_from_slice(b"\x1bc");

    loop {
        if !read_tmux_control_line(reader, &mut line).await? {
            bail!("tmux control client exited while capturing {pane_id}");
        }
        if line.starts_with(b"%exit") {
            bail!("tmux control client detached while capturing {pane_id}");
        }

        if capture_guard.is_some() {
            if control_guard_matches(&line, b"%end ", capture_guard.as_deref()) {
                break;
            }
            if control_guard_matches(&line, b"%error ", capture_guard.as_deref()) {
                bail!("tmux could not capture pane {pane_id}");
            }
            checkpoint.extend_from_slice(&line);
            // capture-pane emits bare lines and read_tmux_control_line strips
            // the control protocol's CR. The browser terminal runs with
            // convertEol disabled (a raw byte sink), so a lone LF moves down
            // without returning to column 0 and the restored screen stair-
            // steps. Re-add the carriage return the pane itself would have.
            checkpoint.extend_from_slice(b"\r\n");
            trim_tmux_checkpoint(&mut checkpoint, policy.max_bytes, CHECKPOINT_TRIM_SLOP);
            continue;
        }

        if let Some(suffix) = control_guard(&line, b"%begin ") {
            active_guard = Some(suffix.to_vec());
            if marker_guard.is_some() {
                capture_guard = Some(suffix.to_vec());
            }
            continue;
        }

        if marker_guard.is_some() {
            if control_guard_matches(&line, b"%end ", marker_guard.as_deref()) {
                active_guard = None;
            }
            continue;
        }

        if line == marker.as_bytes() && active_guard.is_some() {
            marker_guard.clone_from(&active_guard);
            continue;
        }

        if forward_prior_output && active_guard.is_none() {
            if let Some(bytes) = tmux_control_output(&line, pane_id) {
                emit_terminal_data(sink, output_gap, bytes, false);
            }
        }
    }
    trim_tmux_checkpoint(&mut checkpoint, policy.max_bytes, 0);
    Ok(checkpoint)
}

fn control_guard<'a>(line: &'a [u8], prefix: &[u8]) -> Option<&'a [u8]> {
    line.strip_prefix(prefix).filter(|suffix| {
        let mut fields = suffix.split(|byte| *byte == b' ');
        fields.clone().count() == 3
            && fields.all(|field| !field.is_empty() && field.iter().all(u8::is_ascii_digit))
    })
}

fn control_guard_matches(line: &[u8], prefix: &[u8], expected: Option<&[u8]>) -> bool {
    expected.is_some_and(|expected| control_guard(line, prefix) == Some(expected))
}

fn trim_tmux_checkpoint(checkpoint: &mut Vec<u8>, max: usize, slop: usize) {
    const RESET_BYTES: usize = 2;
    if checkpoint.len() <= RESET_BYTES + max + slop {
        return;
    }
    let excess = checkpoint.len() - RESET_BYTES - max;
    let search_from = RESET_BYTES + excess;
    let drain_to = checkpoint[search_from..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(search_from, |offset| search_from + offset + 1);
    checkpoint.drain(RESET_BYTES..drain_to);
}

async fn read_tmux_control_line(
    reader: &mut BufReader<ChildStdout>,
    line: &mut Vec<u8>,
) -> Result<bool> {
    line.clear();
    if reader.read_until(b'\n', line).await? == 0 {
        return Ok(false);
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.len() > 256 * 1024 {
        bail!("tmux control message exceeded 256 KiB");
    }
    Ok(true)
}

fn tmux_control_output(line: &[u8], target_pane: &str) -> Option<Vec<u8>> {
    let (pane, encoded) = if let Some(rest) = line.strip_prefix(b"%output ") {
        split_at_byte(rest, b' ')?
    } else {
        let rest = line.strip_prefix(b"%extended-output ")?;
        let (pane, rest) = split_at_byte(rest, b' ')?;
        let marker = rest.windows(3).position(|window| window == b" : ")?;
        (pane, &rest[marker + 3..])
    };
    if pane != target_pane.as_bytes() {
        return None;
    }
    Some(decode_tmux_control_bytes(encoded))
}

fn split_at_byte(value: &[u8], delimiter: u8) -> Option<(&[u8], &[u8])> {
    let index = value.iter().position(|byte| *byte == delimiter)?;
    Some((&value[..index], &value[index + 1..]))
}

fn decode_tmux_control_bytes(encoded: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'\\' && index + 3 < encoded.len() {
            let digits = &encoded[index + 1..index + 4];
            if digits.iter().all(|digit| (b'0'..=b'7').contains(digit)) {
                decoded.push((digits[0] - b'0') * 64 + (digits[1] - b'0') * 8 + digits[2] - b'0');
                index += 4;
                continue;
            }
        }
        decoded.push(encoded[index]);
        index += 1;
    }
    decoded
}

async fn send_tmux_input(stdin: &mut ChildStdin, pane_id: &str, data: &[u8]) -> Result<()> {
    const INPUT_CHUNK_BYTES: usize = 1024;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for chunk in data.chunks(INPUT_CHUNK_BYTES) {
        let mut command = Vec::with_capacity(24 + chunk.len() * 3);
        command.extend_from_slice(b"send-keys -t ");
        command.extend_from_slice(pane_id.as_bytes());
        command.extend_from_slice(b" -H");
        for byte in chunk {
            command.push(b' ');
            command.push(HEX[(byte >> 4) as usize]);
            command.push(HEX[(byte & 0xf) as usize]);
        }
        command.push(b'\n');
        stdin.write_all(&command).await?;
    }
    stdin.flush().await?;
    Ok(())
}

fn emit_terminal_data(sink: &EventSink, output_gap: &mut bool, bytes: Vec<u8>, full: bool) {
    // Never block the runtime reader on cloud/network backpressure: doing so
    // can fill its command queue and deadlock keyboard input. If the bounded
    // event queue is full, explicitly invalidate replay and let the browser
    // reconnect for a fresh checkpoint.
    if *output_gap {
        if !sink.try_send(StreamEventKind::Gap) {
            return;
        }
        *output_gap = false;
    }
    if !sink.try_send(StreamEventKind::Data { bytes, full }) {
        *output_gap = true;
    }
}

fn gap_retry_interval() -> Interval {
    let mut tick = interval(Duration::from_millis(50));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    tick
}

fn retry_terminal_gap(sink: &EventSink, output_gap: &mut bool) {
    if sink.try_send(StreamEventKind::Gap) {
        *output_gap = false;
    }
}

struct HerdrChild {
    child: Child,
    reader: BufReader<ChildStdout>,
}

async fn spawn_herdr(target: &Target, cols: u16, rows: u16) -> Result<HerdrChild> {
    let mut command = Command::new("herdr");
    command.args(["terminal", "session", "observe", &target.external_id]);
    command.args(["--cols", &cols.to_string(), "--rows", &rows.to_string()]);
    command
        .env("HERDR_SESSION", &target.runtime_session_id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .context("could not start Herdr terminal helper")?;
    let stdout = child.stdout.take().context("Herdr helper has no stdout")?;
    Ok(HerdrChild {
        child,
        reader: BufReader::with_capacity(32 * 1024, stdout),
    })
}

async fn read_herdr_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> Result<bool> {
    line.clear();
    loop {
        let (consumed, newline) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(!line.is_empty());
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(available.len(), |index| index + 1);
            if line.len() + consumed > MAX_HERDR_FRAME_BYTES {
                bail!("Herdr terminal frame exceeded 2 MiB");
            }
            let content_bytes = consumed - usize::from(newline.is_some());
            line.extend_from_slice(&available[..content_bytes]);
            (consumed, newline.is_some())
        };
        reader.consume(consumed);
        if newline {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(true);
        }
    }
}

async fn run_herdr_cli(
    sink: EventSink,
    mut cols: u16,
    mut rows: u16,
    mut rx: mpsc::Receiver<StreamCommand>,
) -> Result<()> {
    let target = sink.target().clone();
    // Rendering and input intentionally use separate Herdr interfaces. The
    // observer produces a virtual frame at the browser's dimensions without
    // changing the native Herdr client. Input goes through the typed pane API,
    // so Terminalz never has to take over the shared terminal controller.
    let mut helper = spawn_herdr(&target, cols, rows).await?;
    let mut output_gap = false;
    let mut gap_tick = gap_retry_interval();
    let mut input_refresh_tick = interval(Duration::from_millis(16));
    input_refresh_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut refresh_after_input: Option<Instant> = None;
    let mut line = Vec::with_capacity(32 * 1024);
    let mut last_frame = String::new();
    let mut composer_cursor_from_end = 0;
    loop {
        tokio::select! {
            read = read_herdr_line(&mut helper.reader, &mut line) => {
                if !read.unwrap_or(false) {
                    let _ = helper.child.start_kill();
                    let _ = helper.child.wait().await;
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    helper = spawn_herdr(&target, cols, rows).await?;
                    last_frame.clear();
                    continue;
                }
                let value: Value = match serde_json::from_slice(&line) { Ok(value) => value, Err(_) => continue };
                    if value.get("type").and_then(Value::as_str) == Some("terminal.frame") && refresh_after_input.is_none() {
                        // The native Herdr pane may be scrolled up. Terminalz is
                        // an agent-first tail view: read logical recent lines,
                        // let each xterm wrap them for its own width, and keep
                        // the composer/model footer at the bottom.
                        emit_herdr_tail(&sink, &target, cols, rows, composer_cursor_from_end, &mut output_gap, &mut last_frame).await?;
                    } else if value.get("type").and_then(Value::as_str) == Some("terminal.closed") { break; }
            }
            _ = input_refresh_tick.tick(), if refresh_after_input.is_some() => {
                if refresh_after_input.is_some_and(|deadline| Instant::now() >= deadline) {
                    refresh_after_input = None;
                    emit_herdr_tail(&sink, &target, cols, rows, composer_cursor_from_end, &mut output_gap, &mut last_frame).await?;
                }
            }
            command = rx.recv() => match command {
                Some(StreamCommand::Input(data)) => {
                    let text = String::from_utf8(data).context("Herdr terminal input was not UTF-8")?;
                    update_herdr_composer_cursor(
                        &text,
                        &last_frame,
                        &mut composer_cursor_from_end,
                    );
                    let herdr_key = herdr_key_for_input(&text);
                    if let Some(key) = herdr_key {
                        let sent = crate::herdr::mutate(
                            &target.runtime_session_id,
                            "pane.send_keys",
                            json!({ "pane_id": target.pane_id, "keys": [key] }),
                        ).await;
                        if let Err(error) = sent {
                            eprintln!("[terminalz] Herdr typed key failed: {error:#}");
                            if let Err(error) = crate::herdr::mutate(
                                &target.runtime_session_id,
                                "pane.send_input",
                                json!({ "pane_id": target.pane_id, "text": text }),
                            ).await {
                                eprintln!("[terminalz] Herdr input fallback failed: {error:#}");
                            }
                        }
                    } else {
                        if let Err(error) = crate::herdr::mutate(
                            &target.runtime_session_id,
                            "pane.send_input",
                            json!({ "pane_id": target.pane_id, "text": text }),
                        ).await {
                            eprintln!("[terminalz] Herdr text input failed: {error:#}");
                        }
                    }
                    // pane.send_input updates pane.read synchronously, but it
                    // does not consistently wake terminal-session observers.
                    // Debounce rapid keystrokes into one authoritative tail
                    // read. Codex is echoed optimistically in its browser, so
                    // intermediate full-canvas snapshots only add latency and
                    // can overwrite newer local input with older state.
                    refresh_after_input = Some(Instant::now() + Duration::from_millis(40));
                }
                Some(StreamCommand::Resize(next_cols, next_rows)) => {
                    cols = next_cols; rows = next_rows;
                    last_frame.clear();
                    let _ = helper.child.start_kill(); let _ = helper.child.wait().await;
                    helper = spawn_herdr(&target, cols, rows).await?;
                }
                Some(StreamCommand::TakeControl) => {}
                Some(StreamCommand::ReleaseControl) => {}
                Some(StreamCommand::Checkpoint(_)) => {
                    let _ = helper.child.start_kill(); let _ = helper.child.wait().await;
                    helper = spawn_herdr(&target, cols, rows).await?;
                }
                Some(StreamCommand::Stop) | None => {
                    let _ = helper.child.start_kill(); break;
                }
            },
            _ = gap_tick.tick(), if output_gap => retry_terminal_gap(&sink, &mut output_gap),
            _ = helper.child.wait() => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                helper = spawn_herdr(&target, cols, rows).await?;
                last_frame.clear();
            },
        }
    }
    sink.send(StreamEventKind::Exit).await;
    Ok(())
}

async fn emit_herdr_tail(
    sink: &EventSink,
    target: &Target,
    cols: u16,
    rows: u16,
    composer_cursor_from_end: usize,
    output_gap: &mut bool,
    last_frame: &mut String,
) -> Result<()> {
    let Ok(response) = crate::herdr::mutate(
        &target.runtime_session_id,
        "pane.read",
        json!({
            "pane_id": target.pane_id,
            "source": "recent_unwrapped",
            "lines": rows,
            "format": "ansi",
        }),
    )
    .await
    else {
        return Ok(());
    };
    let Some(text) = response
        .pointer("/result/read/text")
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    if text != last_frame {
        last_frame.clear();
        last_frame.push_str(text);
        let rendered = render_herdr_tail(text, cols, rows, composer_cursor_from_end);
        emit_terminal_data(sink, output_gap, rendered.into_bytes(), true);
    }
    Ok(())
}

fn render_herdr_tail(text: &str, cols: u16, rows: u16, composer_cursor_from_end: usize) -> String {
    let cols = usize::from(cols.max(1));
    let rows = usize::from(rows.max(1));
    let mut raw_lines = text.split('\n').collect::<Vec<_>>();
    while raw_lines
        .last()
        .is_some_and(|line| line.trim_end_matches(['\r', ' ', '\t']).is_empty())
    {
        raw_lines.pop();
    }
    let mut lines = raw_lines
        .iter()
        .map(|line| compact_herdr_line(line))
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|(_, plain)| plain.is_empty()) {
        lines.pop();
        raw_lines.pop();
    }
    let composer_index = lines
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, (_, plain))| plain.trim_start().starts_with('›').then_some(index));
    if let Some(composer_index) = composer_index {
        let start = composer_index.saturating_sub(1);
        let end = (composer_index + 1).min(lines.len().saturating_sub(1));
        for index in start..=end {
            if let Some(background) = herdr_background_sequence(raw_lines[index]) {
                lines[index].0 =
                    fill_herdr_composer_line(&lines[index].0, &lines[index].1, &background, cols);
            }
        }
    }

    let line_rows = lines
        .iter()
        .map(|(_, plain)| UnicodeWidthStr::width(plain.as_str()).max(1).div_ceil(cols))
        .collect::<Vec<_>>();
    let content_rows = line_rows.iter().sum::<usize>();
    let top_padding = rows.saturating_sub(content_rows);
    let scroll_rows = content_rows.saturating_sub(rows);

    let mut rendered = String::from("\x1bc");
    rendered.push_str(&"\r\n".repeat(top_padding));
    for (index, (ansi, _)) in lines.iter().enumerate() {
        if index > 0 {
            rendered.push_str("\r\n");
        }
        rendered.push_str(ansi);
    }

    let composer = composer_index.map(|index| (index, &lines[index].1));
    if let Some((index, plain)) = composer {
        let trimmed = plain.trim_end();
        let cursor_width = if trimmed.trim_start() == "› Implement {feature}" {
            UnicodeWidthStr::width(plain.as_str()) - UnicodeWidthStr::width(plain.trim_start()) + 2
        } else {
            let characters = trimmed.chars().collect::<Vec<_>>();
            let cursor_character = characters.len().saturating_sub(composer_cursor_from_end);
            let cursor_prefix = characters[..cursor_character].iter().collect::<String>();
            UnicodeWidthStr::width(cursor_prefix.as_str())
        };
        let rows_before = top_padding + line_rows[..index].iter().sum::<usize>();
        let (cursor_line_offset, cursor_col) = if cursor_width == 0 {
            (0, 1)
        } else if cursor_width % cols == 0 {
            (cursor_width / cols - 1, cols)
        } else {
            (cursor_width / cols, cursor_width % cols + 1)
        };
        let cursor_row = (rows_before + cursor_line_offset + 1)
            .saturating_sub(scroll_rows)
            .clamp(1, rows);
        // Paint the caret into the authoritative frame and hide xterm's
        // hardware cursor. Safari's canvas renderer can repaint the hardware
        // cursor at the final footer cell after scrollToBottom even when the
        // last CSI moved it correctly. A frame-owned caret cannot drift.
        rendered.push_str(&format!(
            "\x1b[{cursor_row};{cursor_col}H\x1b[7m \x1b[27m\x1b[{cursor_row};{cursor_col}H\x1b[?25l"
        ));
    } else {
        rendered.push_str("\x1b[?25l");
    }
    rendered
}

fn herdr_key_for_input(input: &str) -> Option<&'static str> {
    const CTRL_KEYS: [&str; 26] = [
        "ctrl+a",
        "ctrl+b",
        "ctrl+c",
        "ctrl+d",
        "ctrl+e",
        "ctrl+f",
        "ctrl+g",
        "Backspace",
        "Tab",
        "ctrl+j",
        "ctrl+k",
        "ctrl+l",
        "Enter",
        "ctrl+n",
        "ctrl+o",
        "ctrl+p",
        "ctrl+q",
        "ctrl+r",
        "ctrl+s",
        "ctrl+t",
        "ctrl+u",
        "ctrl+v",
        "ctrl+w",
        "ctrl+x",
        "ctrl+y",
        "ctrl+z",
    ];
    match input {
        "\r" | "\n" => Some("Enter"),
        "\u{7f}" => Some("Backspace"),
        "\u{1b}" => Some("esc"),
        "\u{1b}\u{7f}" => Some("alt+backspace"),
        "\u{1b}b" => Some("alt+left"),
        "\u{1b}f" => Some("alt+right"),
        "\u{1b}[A" => Some("up"),
        "\u{1b}[B" => Some("down"),
        "\u{1b}[C" => Some("right"),
        "\u{1b}[D" => Some("left"),
        "\u{1b}[13;2u" => Some("shift+enter"),
        _ if input.len() == 1 => {
            let byte = input.as_bytes()[0];
            (1..=26)
                .contains(&byte)
                .then(|| CTRL_KEYS[usize::from(byte - 1)])
        }
        _ => None,
    }
}

fn update_herdr_composer_cursor(input: &str, frame: &str, cursor_from_end: &mut usize) {
    let Some(content) = herdr_composer_content(frame) else {
        *cursor_from_end = 0;
        return;
    };
    let characters = content.chars().collect::<Vec<_>>();
    let length = characters.len();
    *cursor_from_end = (*cursor_from_end).min(length);
    let mut cursor = length - *cursor_from_end;
    match input {
        "\u{1b}[D" => cursor = cursor.saturating_sub(1),
        "\u{1b}[C" => cursor = (cursor + 1).min(length),
        "\u{1b}b" => {
            while cursor > 0 && characters[cursor - 1].is_whitespace() {
                cursor -= 1;
            }
            if cursor > 0 {
                let word = composer_word_character(characters[cursor - 1]);
                while cursor > 0 && composer_word_character(characters[cursor - 1]) == word {
                    cursor -= 1;
                }
            }
        }
        "\u{1b}f" => {
            while cursor < length && characters[cursor].is_whitespace() {
                cursor += 1;
            }
            if cursor < length {
                let word = composer_word_character(characters[cursor]);
                while cursor < length && composer_word_character(characters[cursor]) == word {
                    cursor += 1;
                }
            }
        }
        "\u{1}" | "\u{1b}[H" | "\u{1b}OH" | "\u{1b}[1~" => cursor = 0,
        "\u{5}" | "\u{1b}[F" | "\u{1b}OF" | "\u{1b}[4~" => cursor = length,
        "\r" | "\n" => {
            *cursor_from_end = 0;
            return;
        }
        "\u{1b}[3~" if cursor < length => {
            *cursor_from_end = cursor_from_end.saturating_sub(1);
            return;
        }
        _ => return,
    }
    *cursor_from_end = length - cursor;
}

fn composer_word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

fn herdr_composer_content(frame: &str) -> Option<String> {
    frame.lines().rev().find_map(|line| {
        let (_, plain) = compact_herdr_line(line);
        let prompt = plain.trim_start().strip_prefix('›')?.strip_prefix(' ')?;
        Some(if prompt == "Implement {feature}" {
            String::new()
        } else {
            prompt.to_owned()
        })
    })
}

fn fill_herdr_composer_line(ansi: &str, plain: &str, background: &str, cols: usize) -> String {
    let width = UnicodeWidthStr::width(plain);
    let fill = if width == 0 {
        cols
    } else if width % cols == 0 {
        0
    } else {
        cols - width % cols
    };
    format!("{background}{ansi}{background}{}\x1b[0m", " ".repeat(fill))
}

fn herdr_background_sequence(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if let Some(end) = ansi_sequence_end(bytes, index) {
            let sequence = &line[index..end];
            if sequence.starts_with("\x1b[48;") || sequence.starts_with("\x1b[48:") {
                return Some(sequence.to_owned());
            }
            index = end;
        } else {
            let character = line[index..].chars().next()?;
            index += character.len_utf8();
        }
    }
    None
}

fn compact_herdr_line(line: &str) -> (String, String) {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let bytes = line.as_bytes();
    let mut rendered = String::with_capacity(line.len());
    let mut plain = String::with_capacity(line.len());
    let mut last_content_end = 0;
    let mut index = 0;
    while index < bytes.len() {
        if let Some(end) = ansi_sequence_end(bytes, index) {
            rendered.push_str(&line[index..end]);
            index = end;
            continue;
        }
        let character = line[index..].chars().next().expect("valid UTF-8 character");
        let end = index + character.len_utf8();
        rendered.push(character);
        plain.push(character);
        if !matches!(character, ' ' | '\t') {
            last_content_end = rendered.len();
        }
        index = end;
    }

    let mut compact = rendered[..last_content_end].to_owned();
    let suffix = rendered.as_bytes();
    let mut suffix_index = last_content_end;
    while suffix_index < suffix.len() {
        if let Some(end) = ansi_sequence_end(suffix, suffix_index) {
            compact.push_str(&rendered[suffix_index..end]);
            suffix_index = end;
        } else {
            let character = rendered[suffix_index..]
                .chars()
                .next()
                .expect("valid UTF-8 character");
            suffix_index += character.len_utf8();
        }
    }
    (compact, plain.trim_end_matches([' ', '\t']).to_owned())
}

fn ansi_sequence_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&0x1b) {
        return None;
    }
    if bytes.get(start + 1) != Some(&b'[') {
        return Some((start + 2).min(bytes.len()));
    }
    bytes[start + 2..]
        .iter()
        .position(|byte| (0x40..=0x7e).contains(byte))
        .map(|offset| start + offset + 3)
        .or(Some(bytes.len()))
}

async fn run_herdr(
    sink: EventSink,
    cols: u16,
    rows: u16,
    rx: mpsc::Receiver<StreamCommand>,
) -> Result<()> {
    // Keep Herdr behind its public process boundary. One helper is shared by
    // every browser viewing this target and exists only while that target is
    // open in the cloud; idle inventory never retains a helper process.
    run_herdr_cli(sink, cols, rows, rx).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_target() -> Target {
        Target {
            runtime: "tmux".to_owned(),
            runtime_session_id: "$1".to_owned(),
            pane_id: "%1".to_owned(),
            external_id: "%1".to_owned(),
            cwd: None,
            viewer_id: None,
        }
    }

    fn seed(
        registry: &mut Registry,
        target: &Target,
        generation: u64,
    ) -> mpsc::Receiver<StreamCommand> {
        let (tx, rx) = mpsc::channel(8);
        registry.targets.insert(
            target.clone(),
            SharedStream {
                tx,
                subscribers: HashMap::from([(
                    "stream-1".to_owned(),
                    Subscriber {
                        read_only: true,
                        cols: 80,
                        rows: 24,
                        last_input: Instant::now(),
                    },
                )]),
                driver: None,
                anchor: "stream-1".to_owned(),
                generation,
                cols: 80,
                rows: 24,
                sequence: 0,
                saw_output: false,
            },
        );
        registry
            .by_stream
            .insert("stream-1".to_owned(), target.clone());
        rx
    }

    fn event(target: &Target, generation: u64, kind: StreamEventKind) -> StreamEvent {
        StreamEvent {
            target: target.clone(),
            generation,
            kind,
        }
    }

    #[test]
    fn latest_keystroke_atomically_takes_the_driver_lease() {
        let mut registry = Registry::new();
        let target = test_target();
        let mut rx = seed(&mut registry, &target, 1);
        let shared = registry.targets.get_mut(&target).unwrap();
        shared.subscribers.get_mut("stream-1").unwrap().read_only = false;
        shared.subscribers.insert(
            "stream-2".to_owned(),
            Subscriber {
                read_only: false,
                cols: 100,
                rows: 30,
                last_input: Instant::now(),
            },
        );
        registry
            .by_stream
            .insert("stream-2".to_owned(), target.clone());

        let first = registry.input("stream-1", b"a".to_vec()).unwrap();
        assert!(first
            .iter()
            .any(|message| { message["streamId"] == "stream-1" && message["driver"] == true }));
        assert_eq!(
            registry.targets.get(&target).unwrap().driver.as_deref(),
            Some("stream-1")
        );

        let second = registry.input("stream-2", b"b".to_vec()).unwrap();
        assert!(second
            .iter()
            .any(|message| { message["streamId"] == "stream-2" && message["driver"] == true }));
        assert!(second
            .iter()
            .any(|message| { message["streamId"] == "stream-1" && message["driver"] == false }));
        assert_eq!(
            registry.targets.get(&target).unwrap().driver.as_deref(),
            Some("stream-2")
        );

        assert!(registry
            .input("stream-2", b"c".to_vec())
            .unwrap()
            .is_empty());
        assert!(matches!(rx.try_recv(), Ok(StreamCommand::Resize(80, 24))));
        assert!(matches!(rx.try_recv(), Ok(StreamCommand::Input(data)) if data == b"a"));
        assert!(matches!(rx.try_recv(), Ok(StreamCommand::Resize(100, 30))));
        assert!(matches!(rx.try_recv(), Ok(StreamCommand::Input(data)) if data == b"b"));
        assert!(matches!(rx.try_recv(), Ok(StreamCommand::Input(data)) if data == b"c"));
    }

    #[test]
    fn releasing_driver_returns_herdr_to_observer_mode() {
        let mut registry = Registry::new();
        let mut target = test_target();
        target.runtime = "herdr".to_owned();
        let mut rx = seed(&mut registry, &target, 1);
        registry
            .targets
            .get_mut(&target)
            .unwrap()
            .subscribers
            .get_mut("stream-1")
            .unwrap()
            .read_only = false;

        registry.claim("stream-1");
        assert!(matches!(rx.try_recv(), Ok(StreamCommand::Resize(80, 24))));
        assert!(matches!(rx.try_recv(), Ok(StreamCommand::TakeControl)));

        let updates = registry.release("stream-1");
        assert!(registry.targets.get(&target).unwrap().driver.is_none());
        assert!(updates
            .iter()
            .any(|message| message["streamId"] == "stream-1" && message["driver"] == false));
        assert!(matches!(rx.try_recv(), Ok(StreamCommand::ReleaseControl)));
    }

    #[test]
    fn large_checkpoints_are_chunked_with_explicit_boundaries() {
        let mut registry = Registry::new();
        let target = test_target();
        let _rx = seed(&mut registry, &target, 1);

        let frames = registry.handle_event(event(
            &target,
            1,
            StreamEventKind::Data {
                bytes: vec![b'x'; 300 * 1024],
                full: true,
            },
        ));
        assert_eq!(frames.len(), 1);
        let Outbound::Terminal {
            first_sequence,
            checkpoint,
            bytes,
            ..
        } = &frames[0]
        else {
            panic!("expected terminal output")
        };
        assert_eq!(*first_sequence, 1);
        assert!(*checkpoint);
        let chunk_count = terminal_chunk_count(bytes.len());
        assert_eq!(chunk_count, 2);
        assert_eq!(terminal_checkpoint_flags(true, 0, chunk_count), 1);
        assert_eq!(
            terminal_checkpoint_flags(true, 1, chunk_count),
            (1 << 1) | (1 << 2)
        );
    }

    #[test]
    fn full_output_queue_becomes_an_explicit_gap() {
        let target = test_target();
        let (events, mut rx) = mpsc::channel(1);
        let sink = EventSink {
            events,
            target: target.clone(),
            generation: 1,
        };
        assert!(sink.try_send(StreamEventKind::Data {
            bytes: vec![1],
            full: false,
        }));
        let mut gap = false;
        emit_terminal_data(&sink, &mut gap, vec![2], false);
        assert!(gap);
        let _ = rx.try_recv().unwrap();
        retry_terminal_gap(&sink, &mut gap);
        assert!(!gap);
        assert!(matches!(
            rx.try_recv(),
            Ok(StreamEvent {
                kind: StreamEventKind::Gap,
                ..
            })
        ));
    }

    #[test]
    fn stale_exit_cannot_close_a_reattached_stream() {
        let mut registry = Registry::new();
        let target = test_target();
        let _rx = seed(&mut registry, &target, 7);

        // The detached task from generation 6 reports its exit after the
        // browser has already re-attached under generation 7.
        assert!(registry
            .handle_event(event(&target, 6, StreamEventKind::Exit))
            .is_empty());
        assert!(registry.targets.contains_key(&target));
        assert!(registry.by_stream.contains_key("stream-1"));

        // The live generation still tears the stream down as usual.
        let closed = registry.handle_event(event(&target, 7, StreamEventKind::Exit));
        assert_eq!(closed.len(), 1);
        assert!(!registry.targets.contains_key(&target));
    }

    #[test]
    fn frames_are_tagged_with_a_stable_anchor() {
        let mut registry = Registry::new();
        let target = test_target();
        let _rx = seed(&mut registry, &target, 1);
        for index in 0..8 {
            let id = format!("stream-{}", index + 2);
            registry
                .targets
                .get_mut(&target)
                .unwrap()
                .subscribers
                .insert(
                    id.clone(),
                    Subscriber {
                        read_only: true,
                        cols: 80,
                        rows: 24,
                        last_input: Instant::now(),
                    },
                );
            registry.by_stream.insert(id, target.clone());
        }
        for _ in 0..4 {
            let frames = registry.handle_event(event(
                &target,
                1,
                StreamEventKind::Data {
                    bytes: vec![b'x'],
                    full: false,
                },
            ));
            let Outbound::Terminal { stream_id, .. } = &frames[0] else {
                panic!("expected terminal output")
            };
            assert_eq!(stream_id, "stream-1");
        }

        // Losing the anchor promotes a surviving subscriber rather than
        // leaving frames addressed to a stream the broker has dropped.
        registry.close("stream-1");
        let frames = registry.handle_event(event(
            &target,
            1,
            StreamEventKind::Data {
                bytes: vec![b'x'],
                full: false,
            },
        ));
        let Outbound::Terminal { stream_id, .. } = &frames[0] else {
            panic!("expected terminal output")
        };
        assert_ne!(stream_id, "stream-1");
    }

    #[test]
    fn tmux_control_output_is_binary_safe_and_pane_scoped() {
        assert_eq!(
            tmux_control_output(b"%output %1 hello\\015\\012\\134world", "%1"),
            Some(b"hello\r\n\\world".to_vec())
        );
        assert_eq!(
            tmux_control_output(b"%extended-output %1 17 : \\033[31mred", "%1"),
            Some(b"\x1b[31mred".to_vec())
        );
        assert_eq!(tmux_control_output(b"%output %2 hidden", "%1"), None);
        assert_eq!(tmux_control_output(b"%layout-change @1 layout", "%1"), None);
    }

    #[test]
    fn tmux_control_guards_require_the_matching_command() {
        let guard = control_guard(b"%begin 123 7 0", b"%begin ").unwrap();
        assert!(control_guard_matches(
            b"%end 123 7 0",
            b"%end ",
            Some(guard)
        ));
        assert!(!control_guard_matches(
            b"%end 123 8 0",
            b"%end ",
            Some(guard)
        ));
        assert!(control_guard(b"%begin not-a-guard", b"%begin ").is_none());
    }

    #[test]
    fn tmux_targets_only_accept_stable_pane_ids() {
        assert!(valid_tmux_pane_id("%123"));
        assert!(!valid_tmux_pane_id("%"));
        assert!(!valid_tmux_pane_id("session:0.1"));
        assert!(!valid_tmux_pane_id("%1; kill-server"));
    }

    #[test]
    fn checkpoint_policy_is_bounded_for_untrusted_browser_values() {
        assert_eq!(CheckpointPolicy::new(1, 1).history_lines, 100);
        assert_eq!(CheckpointPolicy::new(1, 1).max_bytes, 64 * 1024);
        assert_eq!(
            CheckpointPolicy::new(u16::MAX, usize::MAX).history_lines,
            2000
        );
        assert_eq!(
            CheckpointPolicy::new(u16::MAX, usize::MAX).max_bytes,
            1024 * 1024
        );
    }

    #[tokio::test]
    async fn herdr_terminal_frames_are_bounded() {
        let mut ordinary = BufReader::new(&b"{\"type\":\"terminal.closed\"}\r\n"[..]);
        let mut line = Vec::new();
        assert!(read_herdr_line(&mut ordinary, &mut line).await.unwrap());
        assert_eq!(line, b"{\"type\":\"terminal.closed\"}");

        let mut oversized = vec![b'x'; MAX_HERDR_FRAME_BYTES + 1];
        oversized.push(b'\n');
        let mut reader = BufReader::new(oversized.as_slice());
        assert!(read_herdr_line(&mut reader, &mut line).await.is_err());
    }

    #[test]
    fn herdr_tail_is_compacted_bottom_aligned_and_cursor_aware() {
        let rendered = render_herdr_tail(
            "\x1b[48;2;59;64;76m› q       \x1b[0m\r\nfooter     \x1b[0m",
            10,
            4,
            0,
        );
        assert!(rendered.starts_with("\x1bc\r\n\r\n"));
        assert!(rendered.contains("› q"));
        assert!(rendered.contains("\x1b[48;2;59;64;76m       \x1b[0m\r\nfooter"));
        assert!(rendered.ends_with("\x1b[3;4H\x1b[7m \x1b[27m\x1b[3;4H\x1b[?25l"));
    }

    #[test]
    fn empty_codex_composer_places_cursor_before_placeholder() {
        let rendered = render_herdr_tail("› Implement {feature}\r\nmodel footer", 40, 2, 0);
        assert!(rendered.ends_with("\x1b[1;3H\x1b[7m \x1b[27m\x1b[1;3H\x1b[?25l"));
    }

    #[test]
    fn codex_cursor_uses_terminal_cell_width_for_wide_input() {
        let rendered = render_herdr_tail("› 🙂\r\nmodel footer", 40, 2, 0);
        assert!(rendered.ends_with("\x1b[1;5H\x1b[7m \x1b[27m\x1b[1;5H\x1b[?25l"));
    }

    #[test]
    fn herdr_input_maps_terminal_controls_to_typed_keys() {
        assert_eq!(herdr_key_for_input("\r"), Some("Enter"));
        assert_eq!(herdr_key_for_input("\u{1b}[D"), Some("left"));
        assert_eq!(herdr_key_for_input("\u{1b}b"), Some("alt+left"));
        assert_eq!(herdr_key_for_input("\u{17}"), Some("ctrl+w"));
        assert_eq!(herdr_key_for_input("z"), None);
        assert_eq!(herdr_key_for_input("pasted text"), None);
    }

    #[test]
    fn herdr_cursor_tracks_word_navigation_inside_composer() {
        let frame = "› one two\r\nmodel footer";
        let mut cursor_from_end = 0;
        update_herdr_composer_cursor("\u{1b}b", frame, &mut cursor_from_end);
        assert_eq!(cursor_from_end, 3);
        let rendered = render_herdr_tail(frame, 40, 2, cursor_from_end);
        assert!(rendered.ends_with("\x1b[1;7H\x1b[7m \x1b[27m\x1b[1;7H\x1b[?25l"));
    }
}
