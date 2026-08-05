use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{
    collections::HashMap,
    time::{Duration, Instant, SystemTime},
};
use tokio::process::{Child, Command};

const DEFAULT_LEASE: Duration = Duration::from_secs(120);
const MIN_LEASE: Duration = Duration::from_secs(30);
const MAX_LEASE: Duration = Duration::from_secs(24 * 60 * 60);

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

    fn priority(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::AcAwake => 1,
            Self::TerminalsAwake => 2,
            Self::DisplayAwake => 3,
        }
    }
}

#[derive(Debug)]
struct PowerLease {
    mode: PowerMode,
    expires_at: Option<Instant>,
    ends_at: Option<SystemTime>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    mode: &'static str,
    active: bool,
    pid: Option<u32>,
    ends_at_unix_ms: Option<u128>,
    lease_count: usize,
}

pub struct PowerManager {
    mode: PowerMode,
    child: Option<Child>,
    leases: HashMap<String, PowerLease>,
}

impl PowerManager {
    pub fn new() -> Self {
        Self {
            mode: PowerMode::Off,
            child: None,
            leases: HashMap::new(),
        }
    }

    pub async fn acquire(
        &mut self,
        lease_id: &str,
        mode: PowerMode,
        duration: Option<Duration>,
    ) -> Result<PowerState> {
        validate_lease_id(lease_id)?;
        if mode != PowerMode::Off && !cfg!(target_os = "macos") {
            bail!("power policy is currently supported on macOS only");
        }
        if mode == PowerMode::Off {
            self.leases.remove(lease_id);
        } else {
            let duration = duration
                .unwrap_or(DEFAULT_LEASE)
                .clamp(MIN_LEASE, MAX_LEASE);
            self.leases.insert(
                lease_id.to_owned(),
                PowerLease {
                    mode,
                    expires_at: Some(Instant::now() + duration),
                    ends_at: Some(SystemTime::now() + duration),
                },
            );
        }
        self.reconcile().await
    }

    pub async fn release(&mut self, lease_id: &str) -> Result<PowerState> {
        validate_lease_id(lease_id)?;
        self.leases.remove(lease_id);
        self.reconcile().await
    }

    /// Compatibility path for older clients. A legacy lease remains until an
    /// explicit stop (or the requested duration), while protocol-v2 browser
    /// clients use short renewable leases so abandoned tabs cannot strand a
    /// machine in a no-sleep state.
    pub async fn start(
        &mut self,
        mode: PowerMode,
        duration: Option<Duration>,
    ) -> Result<PowerState> {
        if mode == PowerMode::Off {
            return self.stop().await;
        }
        if !cfg!(target_os = "macos") {
            bail!("power policy is currently supported on macOS only");
        }
        let duration = duration.map(|value| value.clamp(MIN_LEASE, MAX_LEASE));
        self.leases.insert(
            "legacy".to_owned(),
            PowerLease {
                mode,
                expires_at: duration.map(|duration| Instant::now() + duration),
                ends_at: duration.map(|duration| SystemTime::now() + duration),
            },
        );
        self.reconcile().await
    }

    pub async fn stop(&mut self) -> Result<PowerState> {
        self.leases.clear();
        self.reconcile().await
    }

    pub async fn reap(&mut self) -> Result<PowerState> {
        self.reconcile().await
    }

    pub fn state(&mut self) -> PowerState {
        self.prune_expired();
        if let Some(child) = self.child.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                self.child = None;
                self.mode = PowerMode::Off;
            }
        }
        let ends_at = self.leases.values().filter_map(|lease| lease.ends_at).max();
        PowerState {
            mode: self.mode.as_str(),
            active: self.child.is_some(),
            pid: self.child.as_ref().and_then(Child::id),
            ends_at_unix_ms: ends_at
                .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis()),
            lease_count: self.leases.len(),
        }
    }

    fn prune_expired(&mut self) {
        self.leases.retain(|_, lease| {
            lease
                .expires_at
                .is_none_or(|expires_at| expires_at > Instant::now())
        });
    }

    async fn reconcile(&mut self) -> Result<PowerState> {
        self.prune_expired();
        let desired = self
            .leases
            .values()
            .map(|lease| lease.mode)
            .max_by_key(|mode| mode.priority())
            .unwrap_or(PowerMode::Off);

        let child_running = if let Some(child) = self.child.as_mut() {
            child.try_wait()?.is_none()
        } else {
            false
        };
        if child_running && desired == self.mode {
            return Ok(self.state());
        }
        self.stop_child().await;
        self.mode = PowerMode::Off;
        if desired == PowerMode::Off {
            return Ok(self.state());
        }
        if !cfg!(target_os = "macos") {
            bail!("power policy is currently supported on macOS only");
        }

        let mut command = Command::new("caffeinate");
        match desired {
            // -i prevents idle system sleep but intentionally allows display
            // sleep and lock, which is the default remote-terminal policy.
            PowerMode::TerminalsAwake => command.arg("-i"),
            PowerMode::DisplayAwake => command.args(["-d", "-i"]),
            PowerMode::AcAwake => command.arg("-s"),
            PowerMode::Off => unreachable!(),
        };
        // Tie the assertion to the daemon PID as a second safety net. If the
        // service is SIGKILLed or crashes before Drop/stop_child can run,
        // macOS releases caffeinate automatically instead of leaving an
        // orphaned no-sleep process behind.
        command.args(["-w", &std::process::id().to_string()]);
        command.kill_on_drop(true);
        self.child = Some(command.spawn().context("could not start caffeinate")?);
        self.mode = desired;
        Ok(self.state())
    }

    async fn stop_child(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}

fn validate_lease_id(lease_id: &str) -> Result<()> {
    if lease_id.is_empty()
        || lease_id.len() > 128
        || !lease_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        bail!("invalid power lease id");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn power_mode_priority_matches_policy_strength() {
        assert!(PowerMode::DisplayAwake.priority() > PowerMode::TerminalsAwake.priority());
        assert!(PowerMode::TerminalsAwake.priority() > PowerMode::AcAwake.priority());
        assert!(validate_lease_id("web:abc-123").is_ok());
        assert!(validate_lease_id("bad lease").is_err());
    }
}
