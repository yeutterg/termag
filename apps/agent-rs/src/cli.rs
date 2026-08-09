use crate::config::{self, Config};
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
use tokio::io::AsyncReadExt;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

const MAX_HTTP_BYTES: usize = 4 * 1024 * 1024;

pub async fn run(version: &str) -> Result<bool> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        return Ok(false);
    };
    match command {
        "--version" | "-V" | "-v" => println!("terminalz {version}"),
        "--help" | "-h" | "help" => print_help(version),
        "bootstrap" => bootstrap(&args[1..])?,
        "config" => config_command(&args[1..])?,
        "list" | "ls" => list()?,
        "attach" => attach(&args[1..]).await?,
        unknown => bail!("unknown command {unknown:?}; run `terminalz --help`"),
    }
    Ok(true)
}

fn print_help(version: &str) {
    println!(
        "terminalz {version}\n\n\
Usage:\n  terminalz                 run the lightweight device agent\n  terminalz bootstrap URL   claim a device token from the web UI\n  terminalz config show     print resolved config with a masked token\n  terminalz config set roots JSON\n                            set named allowlisted roots\n  terminalz list            list devices and mirrored sessions\n  terminalz attach TARGET   attach to a project through the broker\n  terminalz --version       print version\n\n\
The protocol-v2 agent discovers local tmux and Herdr sessions automatically;\n\
there are no connect, new, or adopt commands. Detach from `attach` by pressing\n\
Enter followed by ~."
    );
}

fn bootstrap(args: &[String]) -> Result<()> {
    let claim = args
        .first()
        .context("usage: terminalz bootstrap <claim-url>")?;
    if !valid_bootstrap_url(claim) {
        bail!("bootstrap requires HTTPS except on localhost");
    }
    let response = curl_json("POST", claim, None)?;
    if !(200..300).contains(&response.status) {
        bail!("bootstrap claim failed: {}", response.error_message());
    }
    let url = response
        .body
        .get("url")
        .and_then(Value::as_str)
        .context("bootstrap response omitted url")?;
    let token = response
        .body
        .get("token")
        .and_then(Value::as_str)
        .context("bootstrap response omitted token")?;
    let path = config::save_credentials(url, token)?;
    println!("[terminalz] credentials saved to {}", path.display());
    if let Some(name) = response.body.get("deviceName").and_then(Value::as_str) {
        println!("[terminalz] device: {name}");
    }
    if let Some(hint) = response.body.get("hint").and_then(Value::as_str) {
        println!("[terminalz] {hint}");
    }
    println!("[terminalz] next: start terminalz (or `brew services start terminalz`)");
    Ok(())
}

fn config_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str).unwrap_or("show") {
        "show" => println!("{}", config::describe()?),
        "set" if args.get(1).map(String::as_str) == Some("roots") => {
            let roots = args
                .get(2)
                .context("usage: terminalz config set roots '{\"laptop\":\"~/Projects\"}'")?;
            let path = config::set_roots(roots)?;
            println!("[terminalz] roots saved to {}", path.display());
        }
        _ => bail!("usage: terminalz config show | terminalz config set roots JSON"),
    }
    Ok(())
}

fn list() -> Result<()> {
    let config = Config::load()?;
    let (state, _) = fetch_state(&config)?;
    println!("terminalz devices\n");
    if state.devices.is_empty() {
        println!("  (no devices)");
        return Ok(());
    }
    for device in state.devices {
        let state = if device.connected { "●" } else { "○" };
        let kind = device
            .version
            .as_deref()
            .map(|version| format!("v{}", clean(version)))
            .unwrap_or_else(|| "agent".to_owned());
        println!(
            "  {state} {}  {} · {kind}",
            clean(&device.name),
            if device.connected {
                "connected"
            } else {
                "offline"
            }
        );
        for project in device.projects {
            println!(
                "    {} {}  ·  {} tab{}  ·  {}",
                status_mark(&project.status),
                clean(&project.name),
                project.tabs.len(),
                if project.tabs.len() == 1 { "" } else { "s" },
                clean(&project.relative_path)
            );
            for tab in project.tabs {
                println!("        {} {}", status_mark(&tab.status), clean(&tab.name));
            }
        }
    }
    Ok(())
}

async fn attach(args: &[String]) -> Result<()> {
    let mut target = None;
    let mut device = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--device" | "-d" => {
                index += 1;
                device = Some(
                    args.get(index)
                        .context("--device requires a value")?
                        .to_owned(),
                );
            }
            value if value.starts_with("--device=") => {
                device = Some(value["--device=".len()..].to_owned());
            }
            value if value.starts_with('-') => bail!("unknown attach option {value:?}"),
            value => target = Some(value.to_owned()),
        }
        index += 1;
    }
    let target =
        target.context("usage: terminalz attach <project | device:project | session-id>")?;
    let config = Config::load()?;
    let (state, base) = fetch_state(&config)?;
    let resolved = resolve_target(&state, &target, device.as_deref())?;
    attach_socket(&config.token, base, resolved).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliState {
    #[serde(default)]
    devices: Vec<CliDevice>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliDevice {
    name: String,
    connected: bool,
    version: Option<String>,
    #[serde(default)]
    projects: Vec<CliProject>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliProject {
    name: String,
    relative_path: String,
    status: String,
    #[serde(default)]
    tabs: Vec<CliTab>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliTab {
    name: String,
    status: String,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum AttachTarget {
    Agent { session_id: String, label: String },
}

fn resolve_target(state: &CliState, target: &str, filter: Option<&str>) -> Result<AttachTarget> {
    let (explicit_device, project_name) = target
        .split_once(':')
        .map_or((None, target), |(device, project)| (Some(device), project));
    let wanted_device = explicit_device.or(filter).filter(|value| !value.is_empty());

    let matches: Vec<(&CliDevice, &CliProject)> = state
        .devices
        .iter()
        .filter(|device| wanted_device.is_none_or(|wanted| device.name == wanted))
        .flat_map(|device| {
            device
                .projects
                .iter()
                .filter(move |project| project.name == project_name)
                .map(move |project| (device, project))
        })
        .collect();
    if matches.len() > 1 {
        let labels = matches
            .iter()
            .map(|(device, project)| format!("{}:{}", device.name, project.name))
            .collect::<Vec<_>>()
            .join(", ");
        bail!("multiple projects match {project_name:?}: {labels}; use --device");
    }
    if let Some((device, project)) = matches.first() {
        let session_id = project
            .tabs
            .iter()
            .find_map(|tab| tab.session_id.clone())
            .with_context(|| format!("project {project_name:?} has no live terminal session"))?;
        return Ok(AttachTarget::Agent {
            session_id,
            label: format!("{}:{}", device.name, project.name),
        });
    }
    if !target.contains(':')
        && target.starts_with("rs_")
        && target.len() <= 4096
        && target
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Ok(AttachTarget::Agent {
            session_id: target.to_owned(),
            label: format!("session {}…", &target[..8]),
        });
    }
    bail!("no project named {project_name:?}; run `terminalz list`")
}

fn fetch_state(config: &Config) -> Result<(CliState, String)> {
    let (secure, authority) = broker_authority(&config.url)?;
    let state_url = format!(
        "{}://{authority}/api/cli/state",
        if secure { "https" } else { "http" }
    );
    let response = curl_json("GET", &state_url, Some(&config.token))?;
    if !(200..300).contains(&response.status) {
        bail!("broker request failed: {}", response.error_message());
    }
    let state =
        serde_json::from_value(response.body).context("broker returned invalid CLI state")?;
    Ok((state, config.url.clone()))
}

struct HttpResponse {
    status: u16,
    body: Value,
}

impl HttpResponse {
    fn error_message(&self) -> String {
        self.body
            .get("error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("HTTP {}", self.status))
    }
}

fn curl_json(method: &str, url: &str, token: Option<&str>) -> Result<HttpResponse> {
    let mut child = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--max-time",
            "15",
            "--max-filesize",
            "4194304",
            "--request",
            method,
            "--header",
            "accept: application/json",
            "--write-out",
            "\n%{http_code}",
            "--config",
            "-",
            url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not launch curl")?;
    if let Some(token) = token {
        if token.contains(['\r', '\n']) {
            bail!("agent token contains an invalid newline");
        }
        let escaped = token.replace('\\', "\\\\").replace('"', "\\\"");
        writeln!(
            child.stdin.as_mut().context("curl stdin unavailable")?,
            "header = \"authorization: Bearer {escaped}\""
        )?;
    }
    drop(child.stdin.take());
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "curl failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if output.stdout.len() > MAX_HTTP_BYTES + 16 {
        bail!("broker response exceeded 4 MiB");
    }
    let text = String::from_utf8(output.stdout).context("broker response was not UTF-8")?;
    let (body, status) = text
        .rsplit_once('\n')
        .context("curl response omitted HTTP status")?;
    Ok(HttpResponse {
        status: status.trim().parse().context("invalid HTTP status")?,
        body: serde_json::from_str(body).unwrap_or_else(|_| json!({ "error": body.trim() })),
    })
}

async fn attach_socket(token: &str, base: String, target: AttachTarget) -> Result<()> {
    let (label, session_id) = match target {
        AttachTarget::Agent { session_id, label } => (label, session_id),
    };
    let (cols, rows) = terminal_size();
    let (secure, authority) = broker_authority(&base)?;
    let mut query = vec![format!("sessionId={}", percent_encode(&session_id))];
    query.push(format!("cols={cols}"));
    query.push(format!("rows={rows}"));
    let socket_url = format!(
        "{}://{authority}/api/ws/terminal?{}",
        if secure { "wss" } else { "ws" },
        query.join("&")
    );
    let mut request = socket_url.into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    let (socket, _) = connect_async(request)
        .await
        .with_context(|| format!("could not attach to {label}"))?;
    let (mut sink, mut stream) = socket.split();
    let _raw = RawTerminal::enable()?;
    eprintln!("\x1b[2m[terminalz attach {label} · detach with Enter then ~.]\x1b[0m");

    let mut stdin = tokio::io::stdin();
    let mut input = [0_u8; 8192];
    let mut escape = EscapeState::default();
    let mut resize = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())?;
    loop {
        tokio::select! {
            read = stdin.read(&mut input) => {
                let count = read?;
                if count == 0 { break; }
                let (bytes, detach) = escape.filter(&input[..count]);
                if !bytes.is_empty() {
                    sink.send(Message::Text(json!({ "type": "input", "data": String::from_utf8_lossy(&bytes) }).to_string().into())).await?;
                }
                if detach { eprintln!("\r\n[detached]"); break; }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        std::io::stdout().write_all(&bytes)?;
                        std::io::stdout().flush()?;
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            match value.get("type").and_then(Value::as_str) {
                                Some("sleeping") => eprintln!("\r\n[{}]", value.get("message").and_then(Value::as_str).unwrap_or("agent sleeping")),
                                Some("exit") => break,
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => sink.send(Message::Pong(bytes)).await?,
                    Some(Ok(Message::Close(frame))) => {
                        if let Some(frame) = frame { eprintln!("\r\n[closed: {}]", frame.reason); }
                        break;
                    }
                    Some(Err(error)) => return Err(error.into()),
                    None => break,
                    _ => {}
                }
            }
            _ = resize.recv() => {
                let (cols, rows) = terminal_size();
                sink.send(Message::Text(json!({ "type": "resize", "cols": cols, "rows": rows }).to_string().into())).await?;
            }
        }
    }
    let _ = sink.close().await;
    Ok(())
}

struct EscapeState {
    at_line_start: bool,
    pending_tilde: bool,
}

impl Default for EscapeState {
    fn default() -> Self {
        Self {
            at_line_start: true,
            pending_tilde: false,
        }
    }
}

impl EscapeState {
    fn filter(&mut self, input: &[u8]) -> (Vec<u8>, bool) {
        let mut output = Vec::with_capacity(input.len());
        for &byte in input {
            if self.pending_tilde {
                self.pending_tilde = false;
                if byte == b'.' {
                    return (output, true);
                }
                output.push(b'~');
            }
            if self.at_line_start && byte == b'~' {
                self.pending_tilde = true;
                self.at_line_start = false;
                continue;
            }
            output.push(byte);
            self.at_line_start = matches!(byte, b'\r' | b'\n');
        }
        (output, false)
    }
}

struct RawTerminal(Option<libc::termios>);

impl RawTerminal {
    fn enable() -> Result<Self> {
        if unsafe { libc::isatty(libc::STDIN_FILENO) } != 1 {
            return Ok(Self(None));
        }
        let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut original) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut raw = original;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(Some(original)))
    }
}

impl Drop for RawTerminal {
    fn drop(&mut self) {
        if let Some(original) = self.0.as_ref() {
            unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, original) };
        }
    }
}

fn terminal_size() -> (u16, u16) {
    let mut size = unsafe { std::mem::zeroed::<libc::winsize>() };
    if unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) } == 0
        && size.ws_col > 0
        && size.ws_row > 0
    {
        (size.ws_col, size.ws_row)
    } else {
        (80, 24)
    }
}

fn status_mark(status: &str) -> &'static str {
    match status {
        "idle" => "●",
        "working" => "◐",
        "waiting" => "◒",
        "error" => "×",
        _ => "○",
    }
}

fn clean(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                '�'
            } else {
                character
            }
        })
        .collect()
}

fn broker_authority(url: &str) -> Result<(bool, &str)> {
    let (secure, rest) = if let Some(rest) = url.strip_prefix("wss://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("ws://") {
        (false, rest)
    } else {
        bail!("broker URL must use ws:// or wss://");
    };
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|value| !value.is_empty())
        .context("broker URL is missing a host")?;
    if authority.contains('@') {
        bail!("broker URL must not contain credentials");
    }
    Ok((secure, authority))
}

fn valid_bootstrap_url(url: &str) -> bool {
    let (secure, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (false, rest)
    } else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    if secure {
        return true;
    }
    let host = if let Some(ipv6) = authority.strip_prefix('[') {
        ipv6.split(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detach_escape_survives_chunk_boundaries() {
        let mut state = EscapeState::default();
        assert_eq!(state.filter(b"hello\n~"), (b"hello\n".to_vec(), false));
        assert_eq!(state.filter(b"."), (Vec::new(), true));
    }

    #[test]
    fn non_escape_tilde_is_forwarded() {
        let mut state = EscapeState::default();
        assert_eq!(state.filter(b"~x"), (b"~x".to_vec(), false));
    }

    #[test]
    fn bootstrap_allows_only_tls_or_exact_loopback() {
        assert!(valid_bootstrap_url("https://termag.example/api/claim/abc"));
        assert!(valid_bootstrap_url("http://localhost:3000/api/claim/abc"));
        assert!(!valid_bootstrap_url(
            "http://localhost.example/api/claim/abc"
        ));
        assert!(!valid_bootstrap_url("ftp://localhost/claim"));
    }

    #[test]
    fn query_values_are_percent_encoded_without_a_url_stack() {
        assert_eq!(percent_encode("main work/α"), "main%20work%2F%CE%B1");
    }
}
