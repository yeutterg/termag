use crate::protocol::{RuntimeInventory, RuntimePane, RuntimeSession, RuntimeTab, Space};
use anyhow::{bail, Context, Result};
use std::{
    collections::BTreeMap,
    path::Path,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;

const AVAILABILITY_TTL: Duration = Duration::from_secs(30);
type AvailabilityCache = Mutex<Option<(Instant, bool)>>;
static AVAILABILITY: OnceLock<AvailabilityCache> = OnceLock::new();

#[derive(Default)]
struct SessionBuild {
    id: String,
    name: String,
    path: String,
    windows: BTreeMap<i64, TabBuild>,
}

#[derive(Default)]
struct TabBuild {
    id: String,
    name: String,
    ordinal: i64,
    active: bool,
    activity: i64,
    bell: bool,
    panes: Vec<RuntimePane>,
}

pub async fn inventory() -> RuntimeInventory {
    if !command_exists().await {
        return RuntimeInventory::Tmux {
            available: false,
            sessions: Vec::new(),
        };
    }
    match collect().await {
        Ok(sessions) => RuntimeInventory::Tmux {
            available: true,
            sessions,
        },
        Err(_) => RuntimeInventory::Tmux {
            available: true,
            sessions: Vec::new(),
        },
    }
}

async fn command_exists() -> bool {
    let cache = AVAILABILITY.get_or_init(|| Mutex::new(None));
    if let Some((checked_at, available)) = cache.lock().expect("tmux cache poisoned").as_ref() {
        if checked_at.elapsed() < AVAILABILITY_TTL {
            return *available;
        }
    }
    let available = Command::new("tmux")
        .arg("-V")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    *cache.lock().expect("tmux cache poisoned") = Some((Instant::now(), available));
    available
}

async fn collect() -> Result<Vec<RuntimeSession>> {
    let output = Command::new("tmux").args([
        "list-panes", "-a", "-F",
        "#{session_id}\t#{session_name}\t#{session_path}\t#{window_index}\t#{window_id}\t#{window_name}\t#{window_active}\t#{pane_index}\t#{pane_id}\t#{pane_title}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_active}\t#{window_activity}\t#{window_bell_flag}",
    ]).output().await.context("could not list tmux panes")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no server running") || stderr.contains("no sessions") {
            return Ok(Vec::new());
        }
        bail!("tmux list-panes failed: {}", stderr.trim());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let mut sessions: BTreeMap<String, SessionBuild> = BTreeMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let columns: Vec<&str> = line.split('\t').collect();
        if columns.len() < 15 || columns[0].is_empty() {
            continue;
        }
        let session = sessions
            .entry(columns[0].to_owned())
            .or_insert_with(|| SessionBuild {
                id: columns[0].to_owned(),
                name: columns[1].to_owned(),
                path: columns[2].to_owned(),
                windows: BTreeMap::new(),
            });
        let window_index = columns[3].parse::<i64>().unwrap_or(0);
        let window = session
            .windows
            .entry(window_index)
            .or_insert_with(|| TabBuild {
                id: columns[4].to_owned(),
                name: columns[5].to_owned(),
                ordinal: window_index,
                active: columns[6] == "1",
                activity: columns[13].parse().unwrap_or(0),
                bell: columns[14] == "1",
                panes: Vec::new(),
            });
        let pane_index = columns[7]
            .parse::<i64>()
            .unwrap_or(window.panes.len() as i64);
        let command = nonempty(columns[11]);
        let age = now.saturating_sub(window.activity);
        let status = classify(window.bell, age, command.as_deref());
        window.panes.push(RuntimePane {
            id: columns[8].to_owned(),
            terminal_id: columns[8].to_owned(),
            name: nonempty(columns[9]).unwrap_or_else(|| format!("Pane {}", pane_index + 1)),
            ordinal: pane_index,
            status: status.to_owned(),
            focused: columns[12] == "1",
            cwd: nonempty(columns[10]),
            command,
            agent: None,
        });
    }

    Ok(sessions
        .into_values()
        .map(|session| {
            let mut tabs = Vec::new();
            for mut window in session.windows.into_values() {
                window.panes.sort_by_key(|pane| pane.ordinal);
                let status = aggregate(window.panes.iter().map(|pane| pane.status.as_str()));
                tabs.push(RuntimeTab {
                    id: window.id,
                    name: window.name,
                    ordinal: window.ordinal,
                    status,
                    focused: window.active,
                    layout: None,
                    panes: window.panes,
                });
            }
            let status = aggregate(tabs.iter().map(|tab| tab.status.as_str()));
            let space = Space {
                id: session.id.clone(),
                name: session.name.clone(),
                ordinal: 0,
                status: status.clone(),
                focused: tabs.iter().any(|tab| tab.focused),
                active_tab_id: tabs
                    .iter()
                    .find(|tab| tab.focused)
                    .map(|tab| tab.id.clone()),
                tabs,
            };
            RuntimeSession {
                id: session.id,
                name: session.name,
                version: None,
                status_indicators: None,
                path: nonempty(&session.path),
                status,
                spaces: vec![space],
            }
        })
        .collect())
}

pub async fn create_session(name: &str, cwd: &Path) -> Result<()> {
    validate_name(name)?;
    run([
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        &cwd.to_string_lossy(),
    ])
    .await
}

pub async fn create_tab(session: &str, name: &str, cwd: &Path) -> Result<()> {
    validate_name(session)?;
    validate_name(name)?;
    run([
        "new-window",
        "-d",
        "-t",
        session,
        "-n",
        name,
        "-c",
        &cwd.to_string_lossy(),
    ])
    .await
}

pub async fn rename_tab(target: &str, name: &str) -> Result<()> {
    validate_name(name)?;
    run(["rename-window", "-t", target, name]).await
}

pub async fn close_tab(target: &str) -> Result<()> {
    run(["kill-window", "-t", target]).await
}
pub async fn close_session(target: &str) -> Result<()> {
    run(["kill-session", "-t", target]).await
}

pub async fn rename_session(target: &str, name: &str) -> Result<()> {
    validate_name(name)?;
    run(["rename-session", "-t", target, name]).await
}

pub async fn close_pane(target: &str) -> Result<()> {
    run(["kill-pane", "-t", target]).await
}

async fn run<const N: usize>(args: [&str; N]) -> Result<()> {
    let output = Command::new("tmux").args(args).output().await?;
    if output.status.success() {
        Ok(())
    } else {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim())
    }
}

fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.len() > 120 || name.bytes().any(|b| b == 0 || b < 0x20) {
        bail!("invalid tmux name");
    }
    Ok(())
}

fn classify(bell: bool, activity_age: i64, command: Option<&str>) -> &'static str {
    if bell {
        "done"
    } else if activity_age <= 8 {
        "working"
    } else if command.is_some_and(is_shell) {
        "idle"
    } else {
        "unknown"
    }
}

fn is_shell(command: &str) -> bool {
    matches!(
        command.rsplit('/').next().unwrap_or(command),
        "bash" | "zsh" | "fish" | "sh" | "dash" | "nu"
    )
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

fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_priority_and_shell_idle_are_stable() {
        assert_eq!(classify(false, 12, Some("zsh")), "idle");
        assert_eq!(classify(false, 2, Some("zsh")), "working");
        assert_eq!(classify(true, 2, Some("zsh")), "done");
        assert_eq!(aggregate(["idle", "blocked"].into_iter()), "blocked");
    }
}
