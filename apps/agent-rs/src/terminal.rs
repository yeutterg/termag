use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use nix::{
    fcntl::{fcntl, FcntlArg, OFlag},
    pty::{openpty, Winsize},
    unistd::setsid,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    os::fd::AsRawFd,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{unix::AsyncFd, AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::mpsc,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Target {
    pub runtime: String,
    pub runtime_session_id: String,
    pub external_id: String,
    pub tmux_session: Option<String>,
    pub cwd: Option<String>,
}

impl Target {
    pub fn from_value(value: Option<&Value>, fallback_tmux_name: Option<String>) -> Result<Self> {
        let raw = value.and_then(Value::as_object);
        let runtime = raw
            .and_then(|v| v.get("runtime"))
            .and_then(Value::as_str)
            .unwrap_or("tmux")
            .to_owned();
        let runtime_session_id = raw
            .and_then(|v| v.get("runtimeSessionId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| fallback_tmux_name.clone())
            .unwrap_or_default();
        let external_id = raw
            .and_then(|v| v.get("paneId"))
            .and_then(Value::as_str)
            .or_else(|| {
                raw.and_then(|v| v.get("externalId"))
                    .and_then(Value::as_str)
            })
            .map(ToOwned::to_owned)
            .or(fallback_tmux_name)
            .unwrap_or_default();
        if runtime_session_id.is_empty() || external_id.is_empty() {
            bail!("runtime target is incomplete");
        }
        Ok(Self {
            runtime,
            runtime_session_id,
            external_id,
            tmux_session: raw
                .and_then(|v| v.get("tmuxSession"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            cwd: raw
                .and_then(|v| v.get("cwd"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        })
    }
}

#[derive(Debug)]
enum StreamCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
    TakeControl,
    ReleaseControl,
    Stop,
}

#[derive(Debug)]
pub enum StreamEvent {
    Data(Target, String),
    Exit(Target),
    Controller(Target, bool),
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
}

pub struct Registry {
    targets: HashMap<Target, SharedStream>,
    by_stream: HashMap<String, Target>,
    event_tx: mpsc::Sender<StreamEvent>,
    event_rx: mpsc::Receiver<StreamEvent>,
}

impl Registry {
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::channel(256);
        Self {
            targets: HashMap::new(),
            by_stream: HashMap::new(),
            event_tx,
            event_rx,
        }
    }

    pub async fn attach(
        &mut self,
        stream_id: String,
        target: Target,
        cols: u16,
        rows: u16,
        read_only: bool,
    ) -> Result<Vec<Value>> {
        self.close(&stream_id).await;
        if !self.targets.contains_key(&target) {
            let (tx, rx) = mpsc::channel(64);
            let events = self.event_tx.clone();
            let spawn_target = target.clone();
            tokio::spawn(async move {
                let result = if spawn_target.runtime == "herdr" {
                    run_herdr(spawn_target.clone(), cols, rows, rx, events.clone()).await
                } else {
                    run_tmux(spawn_target.clone(), cols, rows, rx, events.clone()).await
                };
                if result.is_err() {
                    let _ = events.send(StreamEvent::Exit(spawn_target)).await;
                }
            });
            self.targets.insert(
                target.clone(),
                SharedStream {
                    tx,
                    subscribers: HashMap::new(),
                    driver: None,
                },
            );
        }
        let shared = self.targets.get_mut(&target).expect("inserted above");
        shared.subscribers.insert(
            stream_id.clone(),
            Subscriber {
                read_only,
                cols,
                rows,
                last_input: Instant::now() - Duration::from_secs(60),
            },
        );
        self.by_stream.insert(stream_id.clone(), target.clone());
        self.resize_target(&target).await;
        Ok(self.driver_messages(&target))
    }

    pub async fn input(&mut self, stream_id: &str, data: Vec<u8>) {
        let Some(target) = self.by_stream.get(stream_id).cloned() else {
            return;
        };
        let Some(shared) = self.targets.get_mut(&target) else {
            return;
        };
        let Some(subscriber) = shared.subscribers.get_mut(stream_id) else {
            return;
        };
        if subscriber.read_only || shared.driver.as_deref() != Some(stream_id) {
            return;
        }
        subscriber.last_input = Instant::now();
        let _ = shared.tx.try_send(StreamCommand::Input(data));
    }

    pub async fn resize(&mut self, stream_id: &str, cols: u16, rows: u16) {
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
        self.resize_target(&target).await;
    }

    pub async fn claim(&mut self, stream_id: &str) -> Vec<Value> {
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
        shared.driver = Some(stream_id.to_owned());
        if target.runtime == "herdr" {
            let _ = shared.tx.send(StreamCommand::TakeControl).await;
        }
        self.driver_messages(&target)
    }

    pub async fn close(&mut self, stream_id: &str) {
        let Some(target) = self.by_stream.remove(stream_id) else {
            return;
        };
        let mut stop = None;
        let mut release = None;
        if let Some(shared) = self.targets.get_mut(&target) {
            shared.subscribers.remove(stream_id);
            if shared.driver.as_deref() == Some(stream_id) {
                shared.driver = None;
                if target.runtime == "herdr" && !shared.subscribers.is_empty() {
                    release = Some(shared.tx.clone());
                }
            }
            if shared.subscribers.is_empty() {
                stop = Some(shared.tx.clone());
            }
        }
        if let Some(tx) = stop {
            let _ = tx.send(StreamCommand::Stop).await;
            self.targets.remove(&target);
        } else if let Some(tx) = release {
            let _ = tx.send(StreamCommand::ReleaseControl).await;
            self.resize_target(&target).await;
        } else {
            self.resize_target(&target).await;
        }
    }

    pub async fn next_event(&mut self) -> Option<StreamEvent> {
        self.event_rx.recv().await
    }

    pub fn handle_event(&mut self, event: StreamEvent) -> Vec<Value> {
        match event {
            StreamEvent::Data(target, data) => self
                .targets
                .get(&target)
                .map(|shared| {
                    shared
                        .subscribers
                        .keys()
                        .map(|stream_id| {
                            json!({
                                "type": "terminal-data", "streamId": stream_id, "data": data,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
            StreamEvent::Controller(target, controlled) => {
                if !controlled {
                    if let Some(shared) = self.targets.get_mut(&target) {
                        shared.driver = None;
                    }
                }
                self.driver_messages(&target)
            }
            StreamEvent::Exit(target) => {
                let Some(shared) = self.targets.remove(&target) else {
                    return Vec::new();
                };
                for stream_id in shared.subscribers.keys() {
                    self.by_stream.remove(stream_id);
                }
                shared
                    .subscribers
                    .keys()
                    .map(|stream_id| json!({ "type": "terminal-exit", "streamId": stream_id }))
                    .collect()
            }
        }
    }

    pub fn len(&self) -> usize {
        self.by_stream.len()
    }

    async fn resize_target(&self, target: &Target) {
        let Some(shared) = self.targets.get(target) else {
            return;
        };
        let cols = shared
            .subscribers
            .values()
            .map(|sub| sub.cols)
            .min()
            .unwrap_or(80)
            .clamp(20, 500);
        let rows = shared
            .subscribers
            .values()
            .map(|sub| sub.rows)
            .min()
            .unwrap_or(24)
            .clamp(5, 200);
        let _ = shared.tx.try_send(StreamCommand::Resize(cols, rows));
    }

    fn driver_messages(&self, target: &Target) -> Vec<Value> {
        self.targets.get(target).map(|shared| shared.subscribers.iter().map(|(id, subscriber)| json!({
            "type": "driver-changed", "streamId": id, "driver": shared.driver.as_deref() == Some(id), "readOnly": subscriber.read_only,
        })).collect()).unwrap_or_default()
    }
}

async fn run_tmux(
    target: Target,
    cols: u16,
    rows: u16,
    mut rx: mpsc::Receiver<StreamCommand>,
    events: mpsc::Sender<StreamEvent>,
) -> Result<()> {
    let tmux_session = target
        .tmux_session
        .clone()
        .unwrap_or_else(|| target.runtime_session_id.clone());
    if target.external_id.starts_with('@') || target.external_id.contains(':') {
        let _ = Command::new("tmux")
            .args(["select-window", "-t", &target.external_id])
            .status()
            .await;
    }
    if target.external_id.starts_with('%') {
        let _ = Command::new("tmux")
            .args(["select-pane", "-t", &target.external_id])
            .status()
            .await;
    }
    let winsize = Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty = openpty(Some(&winsize), None)?;
    let master = File::from(pty.master);
    fcntl(master.as_raw_fd(), FcntlArg::F_SETFL(OFlag::O_NONBLOCK))?;
    let slave = File::from(pty.slave);
    let slave_out = slave.try_clone()?;
    let slave_err = slave.try_clone()?;
    let mut command = Command::new("tmux");
    command.args(["attach-session", "-t", &tmux_session]);
    command.env("TERM", "xterm-256color");
    if let Some(cwd) = &target.cwd {
        command.current_dir(cwd);
    }
    command
        .stdin(Stdio::from(slave))
        .stdout(Stdio::from(slave_out))
        .stderr(Stdio::from(slave_err))
        .kill_on_drop(true);
    unsafe {
        command.pre_exec(|| {
            setsid().map_err(std::io::Error::other)?;
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().context("could not attach tmux PTY")?;
    let master = AsyncFd::new(master)?;
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        tokio::select! {
            ready = master.readable() => {
                let mut ready = ready?;
                match ready.try_io(|inner| {
                    let read = unsafe { libc::read(inner.get_ref().as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
                    if read < 0 { Err(std::io::Error::last_os_error()) } else { Ok(read as usize) }
                }) {
                    Ok(Ok(0)) => break,
                    Ok(Ok(size)) => { let _ = events.send(StreamEvent::Data(target.clone(), String::from_utf8_lossy(&buffer[..size]).into_owned())).await; }
                    Ok(Err(err)) if err.kind() == std::io::ErrorKind::WouldBlock => {}
                    Ok(Err(err)) => return Err(err.into()),
                    Err(_) => {}
                }
            }
            command = rx.recv() => match command {
                Some(StreamCommand::Input(data)) => write_fd(&master, &data).await?,
                Some(StreamCommand::Resize(cols, rows)) => resize_fd(&master, cols, rows)?,
                Some(StreamCommand::TakeControl) => {},
                Some(StreamCommand::ReleaseControl) => {},
                Some(StreamCommand::Stop) | None => { let _ = child.start_kill(); break; }
            },
            _ = child.wait() => break,
        }
    }
    let _ = events.send(StreamEvent::Exit(target)).await;
    Ok(())
}

async fn write_fd(fd: &AsyncFd<File>, mut data: &[u8]) -> Result<()> {
    while !data.is_empty() {
        let mut ready = fd.writable().await?;
        match ready.try_io(|inner| {
            let written = unsafe {
                libc::write(
                    inner.get_ref().as_raw_fd(),
                    data.as_ptr().cast(),
                    data.len(),
                )
            };
            if written < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(written as usize)
            }
        }) {
            Ok(Ok(0)) => break,
            Ok(Ok(size)) => data = &data[size..],
            Ok(Err(err)) if err.kind() == std::io::ErrorKind::WouldBlock => {}
            Ok(Err(err)) => return Err(err.into()),
            Err(_) => {}
        }
    }
    Ok(())
}

fn resize_fd(fd: &AsyncFd<File>, cols: u16, rows: u16) -> Result<()> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let result = unsafe { libc::ioctl(fd.get_ref().as_raw_fd(), libc::TIOCSWINSZ, &size) };
    if result == -1 {
        Err(std::io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}

struct HerdrChild {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    controller: bool,
}

async fn spawn_herdr(
    target: &Target,
    cols: u16,
    rows: u16,
    controller: bool,
) -> Result<HerdrChild> {
    let mut command = Command::new("herdr");
    command.args([
        "terminal",
        "session",
        if controller { "control" } else { "observe" },
        &target.external_id,
    ]);
    if controller {
        command.arg("--takeover");
    }
    command.args(["--cols", &cols.to_string(), "--rows", &rows.to_string()]);
    command
        .env("HERDR_SESSION", &target.runtime_session_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .context("could not start HerdR terminal helper")?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().context("HerdR helper has no stdout")?;
    Ok(HerdrChild {
        child,
        stdin,
        lines: BufReader::new(stdout).lines(),
        controller,
    })
}

async fn run_herdr(
    target: Target,
    mut cols: u16,
    mut rows: u16,
    mut rx: mpsc::Receiver<StreamCommand>,
    events: mpsc::Sender<StreamEvent>,
) -> Result<()> {
    let mut helper = spawn_herdr(&target, cols, rows, false).await?;
    loop {
        tokio::select! {
            line = helper.lines.next_line() => match line? {
                Some(line) => {
                    let value: Value = match serde_json::from_str(&line) { Ok(value) => value, Err(_) => continue };
                    if value.get("type").and_then(Value::as_str) == Some("terminal.frame") {
                        if let Some(bytes) = value.get("bytes").and_then(Value::as_str).and_then(|v| BASE64.decode(v).ok()) {
                            let _ = events.send(StreamEvent::Data(target.clone(), String::from_utf8_lossy(&bytes).into_owned())).await;
                        }
                    } else if value.get("type").and_then(Value::as_str) == Some("terminal.closed") { break; }
                }
                None => break,
            },
            command = rx.recv() => match command {
                Some(StreamCommand::Input(data)) if helper.controller => {
                    if let Some(stdin) = helper.stdin.as_mut() {
                        let line = json!({ "type": "terminal.input", "bytes": BASE64.encode(data) }).to_string() + "\n";
                        stdin.write_all(line.as_bytes()).await?; stdin.flush().await?;
                    }
                }
                Some(StreamCommand::Resize(next_cols, next_rows)) => {
                    cols = next_cols; rows = next_rows;
                    if helper.controller {
                        if let Some(stdin) = helper.stdin.as_mut() {
                            let line = json!({ "type": "terminal.resize", "cols": cols, "rows": rows }).to_string() + "\n";
                            stdin.write_all(line.as_bytes()).await?; stdin.flush().await?;
                        }
                    }
                }
                Some(StreamCommand::TakeControl) if !helper.controller => {
                    let _ = helper.child.start_kill(); let _ = helper.child.wait().await;
                    helper = spawn_herdr(&target, cols, rows, true).await?;
                    let _ = events.send(StreamEvent::Controller(target.clone(), true)).await;
                }
                Some(StreamCommand::TakeControl) => {}
                Some(StreamCommand::ReleaseControl) if helper.controller => {
                    if let Some(stdin) = helper.stdin.as_mut() {
                        let _ = stdin.write_all(b"{\"type\":\"terminal.release\"}\n").await;
                        let _ = stdin.flush().await;
                    }
                    let _ = helper.child.start_kill(); let _ = helper.child.wait().await;
                    helper = spawn_herdr(&target, cols, rows, false).await?;
                    let _ = events.send(StreamEvent::Controller(target.clone(), false)).await;
                }
                Some(StreamCommand::ReleaseControl) => {}
                Some(StreamCommand::Stop) | None => {
                    if helper.controller {
                        if let Some(stdin) = helper.stdin.as_mut() { let _ = stdin.write_all(b"{\"type\":\"terminal.release\"}\n").await; }
                    }
                    let _ = helper.child.start_kill(); break;
                }
                Some(StreamCommand::Input(_)) => {}
            },
            _ = helper.child.wait() => break,
        }
    }
    let _ = events.send(StreamEvent::Exit(target)).await;
    Ok(())
}
