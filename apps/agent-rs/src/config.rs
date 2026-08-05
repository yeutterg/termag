use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Default, Deserialize, Serialize)]
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
            .unwrap_or(5_000)
            .clamp(1_000, 60_000);

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

pub fn config_path() -> Result<PathBuf> {
    let home = home_dir()?;
    Ok(env::var_os("TERMAG_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".termag/config.json")))
}

pub fn save_credentials(url: &str, token: &str) -> Result<PathBuf> {
    let path = config_path()?;
    let mut file = load_file(&path)?;
    file.url = Some(url.trim().to_owned());
    file.agent_token = Some(token.trim().to_owned());
    save_file(&path, &file)?;
    Ok(path)
}

pub fn set_roots(raw: &str) -> Result<PathBuf> {
    let roots: BTreeMap<String, String> =
        serde_json::from_str(raw).context("roots must be a JSON object of name-to-path strings")?;
    if roots.is_empty()
        || roots
            .iter()
            .any(|(name, path)| name.trim().is_empty() || path.trim().is_empty())
    {
        bail!("roots must contain at least one non-empty name and path");
    }
    let path = config_path()?;
    let mut file = load_file(&path)?;
    file.agent_roots = Some(roots);
    save_file(&path, &file)?;
    Ok(path)
}

pub fn describe() -> Result<String> {
    let path = config_path()?;
    let file = load_file(&path)?;
    let resolved = Config::load();
    let (url, token, roots) = match resolved {
        Ok(config) => (Some(config.url), Some(config.token), config.roots),
        Err(_) => {
            let roots = file
                .agent_roots
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|(name, value)| (name, PathBuf::from(value)))
                .collect();
            (file.url.clone(), file.agent_token.clone(), roots)
        }
    };
    let masked = token
        .as_deref()
        .map(mask_token)
        .unwrap_or_else(|| "(unset)".to_owned());
    let roots = if roots.is_empty() {
        "(none)".to_owned()
    } else {
        serde_json::to_string(
            &roots
                .into_iter()
                .map(|(name, path)| (name, path.to_string_lossy().into_owned()))
                .collect::<BTreeMap<_, _>>(),
        )?
    };
    Ok(format!(
        "config file: {}\n  exists:    {}\n\nresolved (env > file):\n  url:       {}\n  token:     {}\n  roots:     {}",
        path.display(),
        if path.exists() { "yes" } else { "no" },
        url.as_deref().unwrap_or("(unset)"),
        masked,
        roots
    ))
}

fn load_file(path: &Path) -> Result<FileConfig> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .with_context(|| format!("could not parse {}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(FileConfig::default()),
        Err(err) => Err(err).with_context(|| format!("could not read {}", path.display())),
    }
}

fn save_file(path: &Path, config: &FileConfig) -> Result<()> {
    let parent = path.parent().context("config path has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("could not create {}", parent.display()))?;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }
    let mut handle = options
        .open(path)
        .with_context(|| format!("could not write {}", path.display()))?;
    handle.write_all(serde_json::to_string_pretty(config)?.as_bytes())?;
    handle.write_all(b"\n")?;
    handle.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn mask_token(token: &str) -> String {
    let prefix: String = token.chars().take(13).collect();
    format!("{prefix}…")
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
    if url.starts_with("wss://") {
        return Ok(());
    }
    // A prefix test is not enough: "ws://localhost.example.com" starts with
    // "ws://localhost" yet resolves to an attacker-controlled host, which
    // would put the bearer token on the wire in plaintext. Compare the host
    // component exactly.
    let Some(authority) = url.strip_prefix("ws://") else {
        bail!("TERMAG_URL must use wss:// unless it points to localhost");
    };
    let authority = authority
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    let host = match authority.strip_prefix('[') {
        // IPv6 literal. Only a port may follow the closing bracket, so
        // "[::1].example.com" must not be read as the loopback address.
        Some(rest) => match rest.split_once(']') {
            Some((host, "")) => host,
            Some((host, port)) if port.starts_with(':') => host,
            _ => bail!("TERMAG_URL has a malformed IPv6 host"),
        },
        None => authority.split(':').next().unwrap_or_default(),
    };
    if matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return Ok(());
    }
    bail!("TERMAG_URL must use wss:// unless it points to localhost");
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
        assert!(validate_url("ws://127.0.0.1/api/ws/agent").is_ok());
        assert!(validate_url("ws://[::1]:3000/api/ws/agent").is_ok());
        assert!(validate_url("wss://example.com/api/ws/agent").is_ok());
    }

    #[test]
    fn loopback_prefixes_do_not_authorize_remote_hosts() {
        // Each of these begins with a loopback spelling but resolves
        // elsewhere; sending the agent token to them unencrypted would leak
        // it to whoever controls that DNS name.
        assert!(validate_url("ws://localhost.example.com/api/ws/agent").is_err());
        assert!(validate_url("ws://127.0.0.1.example.com/api/ws/agent").is_err());
        assert!(validate_url("ws://localhost@example.com/api/ws/agent").is_err());
        assert!(validate_url("ws://[::1].example.com/api/ws/agent").is_err());
    }
}
