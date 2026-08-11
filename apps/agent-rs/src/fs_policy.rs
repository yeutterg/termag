use crate::config::Config;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};
use tokio::process::Command;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    name: String,
    is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryParent {
    root_key: String,
    relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    root_key: String,
    relative_path: String,
    absolute_path: String,
    parent: Option<DirectoryParent>,
    entries: Vec<DirectoryEntry>,
    truncated: bool,
    // The Node agent returns the full root map alongside every listing and
    // lib/broker.ts types it as required, so omitting it made the browse API
    // shape depend on which agent answered.
    roots: BTreeMap<String, String>,
}

const MAX_ENTRIES: usize = 500;
pub const MAX_UPLOAD_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_UPLOAD_BYTES: u64 = 16 * 1024 * 1024;
pub const UPLOAD_TTL: Duration = Duration::from_secs(24 * 60 * 60);
static UPLOAD_DIRECTORIES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static CONTAINER_TARGETS: OnceLock<Mutex<HashMap<String, ContainerUploadTarget>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct ContainerUploadTarget {
    host_directory: PathBuf,
    visible_directory: PathBuf,
}

pub struct UploadChunk<'a> {
    pub root_key: &'a str,
    pub relative_directory: &'a str,
    pub file_name: &'a str,
    pub upload_id: &'a str,
    pub offset: u64,
    pub bytes: &'a [u8],
    pub container_target: Option<&'a ContainerUploadTarget>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DockerMount {
    #[serde(rename = "Type")]
    kind: String,
    source: PathBuf,
    destination: PathBuf,
    #[serde(rename = "RW")]
    writable: bool,
}

fn valid_container_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' => true,
            b'_' | b'.' | b'-' => index > 0,
            _ => false,
        })
}

fn select_container_mount(
    config: &Config,
    mounts: Vec<DockerMount>,
) -> Result<ContainerUploadTarget> {
    let mut candidates = mounts
        .into_iter()
        .filter(|mount| mount.kind == "bind" && mount.writable && mount.destination.is_absolute())
        .filter_map(|mount| {
            let source = fs::canonicalize(&mount.source).ok()?;
            ensure_allowed(config, &source).ok()?;
            Some((source, mount.destination))
        })
        .collect::<Vec<_>>();
    // Hermes conventionally mounts its durable data at /opt/data. Prefer it
    // when multiple writable binds exist, then use the most specific target.
    candidates.sort_by(|left, right| {
        let left_preferred = left.1 == Path::new("/opt/data");
        let right_preferred = right.1 == Path::new("/opt/data");
        right_preferred.cmp(&left_preferred).then_with(|| {
            right
                .1
                .components()
                .count()
                .cmp(&left.1.components().count())
        })
    });
    let (host_root, visible_root) = candidates
        .into_iter()
        .next()
        .context("container has no writable bind mount allowed by Terminalz directory policy")?;
    Ok(ContainerUploadTarget {
        host_directory: host_root.join(".terminalz-uploads"),
        visible_directory: visible_root.join(".terminalz-uploads"),
    })
}

pub async fn resolve_container_upload_target(
    config: &Config,
    container_name: &str,
) -> Result<ContainerUploadTarget> {
    if !valid_container_name(container_name) {
        bail!("invalid container name");
    }
    if let Some(cached) = CONTAINER_TARGETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| anyhow::anyhow!("container upload cache is unavailable"))?
        .get(container_name)
        .cloned()
    {
        return Ok(cached);
    }
    let output = Command::new("docker")
        .args(["inspect", "--format", "{{json .Mounts}}", container_name])
        .output()
        .await
        .context("could not inspect Hermes container")?;
    if !output.status.success() {
        bail!("Hermes container is not available");
    }
    let mounts: Vec<DockerMount> =
        serde_json::from_slice(&output.stdout).context("container mount metadata is invalid")?;
    let target = select_container_mount(config, mounts)?;
    CONTAINER_TARGETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| anyhow::anyhow!("container upload cache is unavailable"))?
        .insert(container_name.to_owned(), target.clone());
    Ok(target)
}

fn prepare_upload_directory(config: &Config, terminal_directory: &Path) -> Result<PathBuf> {
    prepare_upload_directory_at(config, terminal_directory.join(".terminalz-uploads"))
}

fn prepare_upload_directory_at(config: &Config, requested: PathBuf) -> Result<PathBuf> {
    fs::create_dir_all(&requested).with_context(|| {
        format!(
            "could not create upload staging directory {}",
            requested.display()
        )
    })?;
    let directory = fs::canonicalize(requested)?;
    if !directory.is_dir() {
        bail!("upload staging path is not a directory");
    }
    ensure_allowed(config, &directory)?;
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    cleanup_upload_directory(&directory, SystemTime::now())?;
    UPLOAD_DIRECTORIES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| anyhow::anyhow!("upload cleanup registry is unavailable"))?
        .insert(directory.clone());
    Ok(directory)
}

fn cleanup_upload_directory(directory: &Path, now: SystemTime) -> Result<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        let expired = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= UPLOAD_TTL);
        if expired {
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Removes expired uploads from terminal-local staging directories seen by
/// this daemon. A terminal process gives us no
/// reliable signal that an AI agent has finished opening a path, so immediate
/// deletion would race the consumer. A conservative TTL keeps the files
/// usable while bounding their lifetime on the target machine.
pub fn cleanup_stale_uploads() -> Result<usize> {
    let directories = UPLOAD_DIRECTORIES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| anyhow::anyhow!("upload cleanup registry is unavailable"))?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let now = SystemTime::now();
    let mut removed = 0;
    for directory in directories {
        match cleanup_upload_directory(&directory, now) {
            Ok(count) => removed += count,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(removed)
}

pub fn write_upload_chunk(config: &Config, chunk: UploadChunk<'_>) -> Result<PathBuf> {
    let UploadChunk {
        root_key,
        relative_directory,
        file_name,
        upload_id,
        offset,
        bytes,
        container_target,
    } = chunk;
    if bytes.len() > MAX_UPLOAD_CHUNK_BYTES || offset + bytes.len() as u64 > MAX_UPLOAD_BYTES {
        bail!("file upload exceeds the 16 MiB limit");
    }
    if upload_id.len() != 32 || !upload_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid upload id");
    }
    let name_path = Path::new(file_name);
    if file_name.is_empty()
        || file_name.len() > 255
        || name_path.file_name().and_then(|name| name.to_str()) != Some(file_name)
        || file_name.bytes().any(|byte| byte == 0 || byte < 0x20)
    {
        bail!("invalid upload file name");
    }
    // Resolve the target terminal's cwd locally. Keeping the staging directory
    // beneath this location makes the upload visible to workspace-sandboxed
    // coding agents without trusting a browser-provided absolute path.
    let terminal_directory = resolve_creation_path(config, Some(root_key), relative_directory)?;
    let (upload_directory, visible_directory) = if let Some(target) = container_target {
        (
            prepare_upload_directory_at(config, target.host_directory.clone())?,
            target.visible_directory.clone(),
        )
    } else {
        let directory = prepare_upload_directory(config, &terminal_directory)?;
        (directory.clone(), directory)
    };
    let staged_name = format!("{upload_id}-{file_name}");
    let destination = upload_directory.join(&staged_name);
    let mut options = fs::OpenOptions::new();
    options.write(true);
    if offset == 0 {
        options.create_new(true);
    }
    let mut file = options.open(&destination)?;
    if file.metadata()?.len() != offset {
        bail!("upload chunk is out of sequence");
    }
    file.seek(SeekFrom::End(0))?;
    file.write_all(bytes)?;
    Ok(visible_directory.join(staged_name))
}

pub fn resolve_creation_path(
    config: &Config,
    root_key: Option<&str>,
    relative: &str,
) -> Result<PathBuf> {
    reject_relative_traversal(relative)?;
    // An absolute path is never accepted from the wire. Previously the
    // rootless branch passed one straight through, so omitting `rootKey`
    // was a strictly weaker path than supplying it — the allowlist was the
    // only remaining check. Resolve rootless requests against the default
    // root instead so both branches enforce the same containment.
    if Path::new(relative).is_absolute() {
        bail!("path must be relative to a configured root");
    }
    let root = match root_key {
        Some(key) => config
            .roots
            .get(key)
            .with_context(|| format!("unknown root {key:?}"))?,
        None => config
            .roots
            .values()
            .next()
            .context("no directory roots are configured")?,
    };
    let candidate = root.join(relative);
    let canonical_parent = canonicalize_with_missing_leaf(&candidate)?;
    let canonical_root = fs::canonicalize(root)?;
    if canonical_parent != canonical_root && !canonical_parent.starts_with(&canonical_root) {
        bail!("path escapes root {:?}", root_key.unwrap_or("(default)"));
    }
    ensure_allowed(config, &canonical_parent)?;
    // Pass the canonicalized path to Herdr/tmux. Returning the original
    // symlinked spelling would reopen a TOCTOU window where a local process
    // swaps the symlink after policy validation but before runtime creation.
    Ok(canonical_parent)
}

pub fn list_directory(config: &Config, root_key: &str, relative: &str) -> Result<DirectoryListing> {
    let path = resolve_creation_path(config, Some(root_key), relative)?;
    let canonical =
        fs::canonicalize(&path).with_context(|| format!("cannot open {}", path.display()))?;
    ensure_allowed(config, &canonical)?;
    let root = config.roots.get(root_key).context("unknown root")?;
    let canonical_root = fs::canonicalize(root)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&canonical)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let is_dir = if ty.is_dir() {
            true
        } else if ty.is_symlink() {
            fs::canonicalize(entry.path())
                .ok()
                .filter(|target| target.is_dir())
                .is_some_and(|target| {
                    target == canonical_root || target.starts_with(&canonical_root)
                })
        } else {
            false
        };
        if !is_dir {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(DirectoryEntry { name, is_dir: true });
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(DirectoryListing {
        root_key: root_key.to_owned(),
        relative_path: relative.to_owned(),
        absolute_path: canonical.to_string_lossy().into_owned(),
        parent: (!relative.is_empty()).then(|| DirectoryParent {
            root_key: root_key.to_owned(),
            relative_path: Path::new(relative)
                .parent()
                .filter(|path| *path != Path::new("."))
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }),
        entries,
        truncated,
        roots: config
            .roots
            .iter()
            .map(|(key, path)| (key.clone(), path.to_string_lossy().into_owned()))
            .collect(),
    })
}

fn reject_relative_traversal(value: &str) -> Result<()> {
    if value
        .as_bytes()
        .iter()
        .any(|byte| *byte == 0 || *byte < 0x20)
    {
        bail!("path contains control characters");
    }
    if Path::new(value)
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("path contains '..'");
    }
    Ok(())
}

fn ensure_allowed(config: &Config, path: &Path) -> Result<()> {
    if config.allow_all_directories {
        return Ok(());
    }
    for allowed in &config.allow_directories {
        let canonical = fs::canonicalize(allowed).unwrap_or_else(|_| allowed.clone());
        if path == canonical || path.starts_with(&canonical) {
            return Ok(());
        }
    }
    bail!(
        "{} is outside the configured directory allowlist",
        path.display()
    )
}

fn canonicalize_with_missing_leaf(path: &Path) -> Result<PathBuf> {
    let mut cursor = path;
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(cursor) {
            Ok(mut base) => {
                for segment in suffix.iter().rev() {
                    base.push(segment);
                }
                return Ok(base);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = cursor.file_name() else {
                    return Err(err.into());
                };
                suffix.push(name.to_os_string());
                cursor = cursor.parent().context("path has no existing parent")?;
            }
            Err(err) => return Err(err.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn traversal_is_rejected_before_normalization() {
        assert!(reject_relative_traversal("safe/../escape").is_err());
        assert!(reject_relative_traversal("safe/path").is_ok());
    }

    #[test]
    fn uploads_are_staged_inside_the_target_terminal_workspace() {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "terminalz-upload-test-{}-{nonce}",
            std::process::id()
        ));
        let terminal_directory = base.join("project");
        fs::create_dir_all(&terminal_directory).unwrap();
        let config = Config {
            url: "ws://127.0.0.1:3001/api/ws/agent".to_owned(),
            token: "test-token".to_owned(),
            roots: BTreeMap::from([("work".to_owned(), base.clone())]),
            allow_directories: vec![base.clone()],
            allow_all_directories: false,
            inventory_interval_ms: 5_000,
        };
        let upload_id = "a".repeat(32);

        let path = write_upload_chunk(
            &config,
            UploadChunk {
                root_key: "work",
                relative_directory: "project",
                file_name: "image.png",
                upload_id: &upload_id,
                offset: 0,
                bytes: b"first",
                container_target: None,
            },
        )
        .unwrap();
        write_upload_chunk(
            &config,
            UploadChunk {
                root_key: "work",
                relative_directory: "project",
                file_name: "image.png",
                upload_id: &upload_id,
                offset: 5,
                bytes: b"second",
                container_target: None,
            },
        )
        .unwrap();

        let expected_upload_directory = terminal_directory.join(".terminalz-uploads");
        assert!(path.starts_with(fs::canonicalize(&expected_upload_directory).unwrap()));
        assert_eq!(fs::read(path).unwrap(), b"firstsecond");
        assert_eq!(cleanup_stale_uploads().unwrap(), 0);

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn hermes_uploads_use_an_allowed_writable_container_mount() {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "terminalz-container-upload-test-{}-{nonce}",
            std::process::id()
        ));
        let data = base.join("hermes-data");
        fs::create_dir_all(&data).unwrap();
        let config = Config {
            url: "ws://127.0.0.1:3001/api/ws/agent".to_owned(),
            token: "test-token".to_owned(),
            roots: BTreeMap::from([("work".to_owned(), base.clone())]),
            allow_directories: vec![base.clone()],
            allow_all_directories: false,
            inventory_interval_ms: 5_000,
        };

        let target = select_container_mount(
            &config,
            vec![DockerMount {
                kind: "bind".to_owned(),
                source: data.clone(),
                destination: PathBuf::from("/opt/data"),
                writable: true,
            }],
        )
        .unwrap();

        assert_eq!(
            target.host_directory,
            fs::canonicalize(&data).unwrap().join(".terminalz-uploads")
        );
        assert_eq!(
            target.visible_directory,
            PathBuf::from("/opt/data/.terminalz-uploads")
        );
        assert!(valid_container_name("hermes-personal"));
        assert!(!valid_container_name("../hermes"));

        fs::remove_dir_all(base).unwrap();
    }
}
