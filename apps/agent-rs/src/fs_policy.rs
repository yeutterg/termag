use crate::config::Config;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{
    fs,
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
}

const MAX_ENTRIES: usize = 500;

pub fn resolve_creation_path(
    config: &Config,
    root_key: Option<&str>,
    relative: &str,
) -> Result<PathBuf> {
    reject_relative_traversal(relative)?;
    let candidate = if let Some(key) = root_key {
        if Path::new(relative).is_absolute() {
            bail!("path must be relative to the selected root");
        }
        let root = config
            .roots
            .get(key)
            .with_context(|| format!("unknown root {key:?}"))?;
        root.join(relative)
    } else {
        PathBuf::from(relative)
    };
    let canonical_parent = canonicalize_with_missing_leaf(&candidate)?;
    if let Some(key) = root_key {
        let root = fs::canonicalize(config.roots.get(key).context("unknown root")?)?;
        if canonical_parent != root && !canonical_parent.starts_with(&root) {
            bail!("path escapes root {key:?}");
        }
    }
    ensure_allowed(config, &canonical_parent)?;
    Ok(candidate)
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
