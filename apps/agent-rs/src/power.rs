use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::time::{Duration, SystemTime};
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerMode {
    Off,
    TerminalsAwake,
    DisplayAwake,
    AcAwake,
}

impl PowerMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "off" | "disabled" => Some(Self::Off),
            "terminals-awake" | "while-task" | "forever" => Some(Self::TerminalsAwake),
            "display-awake" => Some(Self::DisplayAwake),
            "ac-awake" => Some(Self::AcAwake),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::TerminalsAwake => "terminals-awake",
            Self::DisplayAwake => "display-awake",
            Self::AcAwake => "ac-awake",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    mode: &'static str,
    active: bool,
    pid: Option<u32>,
    ends_at_unix_ms: Option<u128>,
}

pub struct PowerManager {
    mode: PowerMode,
    child: Option<Child>,
    ends_at: Option<SystemTime>,
}

impl PowerManager {
    pub fn new() -> Self {
        Self {
            mode: PowerMode::Off,
            child: None,
            ends_at: None,
        }
    }

    pub async fn start(
        &mut self,
        mode: PowerMode,
        duration: Option<Duration>,
    ) -> Result<PowerState> {
        self.stop().await?;
        if mode == PowerMode::Off {
            return Ok(self.state());
        }
        if !cfg!(target_os = "macos") {
            bail!("power policy is currently supported on macOS only");
        }
        let mut command = Command::new("caffeinate");
        match mode {
            PowerMode::TerminalsAwake => {
                command.arg("-i");
            }
            PowerMode::DisplayAwake => {
                command.args(["-d", "-i"]);
            }
            PowerMode::AcAwake => {
                command.arg("-s");
            }
            PowerMode::Off => unreachable!(),
        }
        if let Some(duration) = duration {
            command.args(["-t", &duration.as_secs().max(1).to_string()]);
        }
        command.kill_on_drop(true);
        self.child = Some(command.spawn().context("could not start caffeinate")?);
        self.mode = mode;
        self.ends_at = duration.map(|duration| SystemTime::now() + duration);
        Ok(self.state())
    }

    pub async fn stop(&mut self) -> Result<PowerState> {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        self.mode = PowerMode::Off;
        self.ends_at = None;
        Ok(self.state())
    }

    pub fn state(&mut self) -> PowerState {
        if let Some(child) = self.child.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                self.child = None;
                self.mode = PowerMode::Off;
                self.ends_at = None;
            }
        }
        PowerState {
            mode: self.mode.as_str(),
            active: self.child.is_some(),
            pid: self.child.as_ref().and_then(Child::id),
            ends_at_unix_ms: self
                .ends_at
                .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis()),
        }
    }
}
