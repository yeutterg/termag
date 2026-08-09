use crate::config::Config;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    io::{Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

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

pub fn write_upload_chunk(
    config: &Config,
    root_key: &str,
    relative_directory: &str,
    file_name: &str,
    upload_id: &str,
    offset: u64,
    bytes: &[u8],
) -> Result<PathBuf> {
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
    let directory = resolve_creation_path(config, Some(root_key), relative_directory)?;
    let upload_directory = directory.join(".terminalz-uploads");
    fs::create_dir_all(&upload_directory)?;
    let upload_directory = fs::canonicalize(upload_directory)?;
    ensure_allowed(config, &upload_directory)?;
    let destination = upload_directory.join(format!("{}-{}", &upload_id[..8], file_name));
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
    Ok(destination)
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

    #[test]
    fn traversal_is_rejected_before_normalization() {
        assert!(reject_relative_traversal("safe/../escape").is_err());
        assert!(reject_relative_traversal("safe/path").is_ok());
    }
}
