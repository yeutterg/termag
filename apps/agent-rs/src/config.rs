use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    url: Option<String>,
    agent_token: Option<String>,
    agent_roots: Option<BTreeMap<String, String>>,
    allow_directories: Option<Vec<String>>,
    allow_all_directories: Option<bool>,
    inventory_interval_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub url: String,
    pub token: String,
    pub roots: BTreeMap<String, PathBuf>,
    pub allow_directories: Vec<PathBuf>,
    pub allow_all_directories: bool,
    pub inventory_interval_ms: u64,
}

impl Config {
    pub fn load() -> Result<Self> {
        let home = home_dir()?;
        let path = env::var_os("TERMAG_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".termag/config.json"));
        let file = match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str::<FileConfig>(&raw)
                .with_context(|| format!("could not parse {}", path.display()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => FileConfig::default(),
            Err(err) => {
                return Err(err).with_context(|| format!("could not read {}", path.display()))
            }
        };

        let url = env::var("TERMAG_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or(file.url)
            .map(|v| v.trim().to_owned());
        let token = env::var("TERMAG_AGENT_TOKEN")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or(file.agent_token)
            .map(|v| v.trim().to_owned());
        let Some(url) = url else {
            bail!("TERMAG_URL is not configured")
        };
        let Some(token) = token else {
            bail!("TERMAG_AGENT_TOKEN is not configured")
        };
        validate_url(&url)?;

        let env_roots = env::var("TERMAG_AGENT_ROOTS")
            .ok()
            .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).ok());
        let raw_roots = env_roots.or(file.agent_roots).unwrap_or_default();
        let mut roots = BTreeMap::new();
        for (key, value) in raw_roots {
            if key.trim().is_empty() || value.trim().is_empty() {
                continue;
            }
            roots.insert(key, expand_home(&value, &home));
        }
        if roots.is_empty() {
            roots.insert("home".to_owned(), home.clone());
        }

        let allow_all_directories = env_bool("TERMAG_ALLOW_ALL_DIRECTORIES")
            .unwrap_or(file.allow_all_directories.unwrap_or(false));
        let raw_allow = env::var("TERMAG_ALLOW_DIRECTORIES")
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .or(file.allow_directories);
        let mut allow_directories: Vec<PathBuf> = raw_allow
            .unwrap_or_else(|| vec![home.to_string_lossy().into_owned()])
            .iter()
            .map(|value| expand_home(value, &home))
            .collect();
        for path in roots.values() {
            if !allow_directories.contains(path) {
                allow_directories.push(path.clone());
            }
        }

        let inventory_interval_ms = env::var("TERMAG_INVENTORY_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .or(file.inventory_interval_ms)
            .unwrap_or(2_000)
            .clamp(500, 60_000);

        Ok(Self {
            url,
            token,
            roots,
            allow_directories,
            allow_all_directories,
            inventory_interval_ms,
        })
    }
}

pub fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set")
}

fn expand_home(value: &str, home: &Path) -> PathBuf {
    if value == "~" || value == "$HOME" {
        return home.to_path_buf();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home.join(rest);
    }
    if let Some(rest) = value.strip_prefix("$HOME/") {
        return home.join(rest);
    }
    PathBuf::from(value)
}

fn validate_url(url: &str) -> Result<()> {
    let secure = url.starts_with("wss://");
    let local = url.starts_with("ws://localhost")
        || url.starts_with("ws://127.0.0.1")
        || url.starts_with("ws://[::1]");
    if !secure && !local {
        bail!("TERMAG_URL must use wss:// unless it points to localhost");
    }
    Ok(())
}

fn env_bool(name: &str) -> Option<bool> {
    env::var(name)
        .ok()
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_plaintext_remote_broker() {
        assert!(validate_url("ws://example.com/api/ws/agent").is_err());
        assert!(validate_url("ws://localhost:3000/api/ws/agent").is_ok());
        assert!(validate_url("wss://example.com/api/ws/agent").is_ok());
    }
}
