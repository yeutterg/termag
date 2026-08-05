use crate::protocol::Incoming;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{path::Component, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::timeout,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STREAM_BYTES: usize = 512 * 1024;
const MAX_PATHS: usize = 100;
const MAX_BRANCH_BYTES: usize = 240;
const MAX_COMMIT_BYTES: usize = 4 * 1024;

pub async fn execute(kind: &str, cwd: &str, incoming: &Incoming) -> Result<Value> {
    let args = arguments(kind, incoming)?;
    if kind == "git.branch" {
        validate_branch(
            cwd,
            incoming.string("branch").as_deref().unwrap_or_default(),
        )
        .await?;
    }
    run(cwd, &args).await
}

fn arguments(kind: &str, incoming: &Incoming) -> Result<Vec<String>> {
    match kind {
        "git.status" => Ok(strings(["status", "--short", "--branch"])),
        "git.branch" => {
            let branch = validate_text(
                "branch",
                incoming.string("branch").as_deref().unwrap_or_default(),
                MAX_BRANCH_BYTES,
            )?;
            Ok(vec!["switch".into(), "--".into(), branch])
        }
        "git.commit" => {
            let message = validate_text(
                "commit message",
                incoming.string("message").as_deref().unwrap_or_default(),
                MAX_COMMIT_BYTES,
            )?;
            Ok(vec!["commit".into(), "-m".into(), message])
        }
        "git.push" => Ok(strings(["push"])),
        "git.pull" => Ok(strings(["pull", "--ff-only"])),
        "git.stage" => {
            let paths = incoming
                .value("paths")
                .and_then(Value::as_array)
                .context("paths are required")?;
            if paths.is_empty() || paths.len() > MAX_PATHS {
                bail!("paths must contain between 1 and {MAX_PATHS} entries");
            }
            let mut args = strings(["add", "--"]);
            for value in paths {
                let path = value.as_str().context("every path must be a string")?;
                validate_path(path)?;
                args.push(path.to_owned());
            }
            Ok(args)
        }
        _ => bail!("unsupported git operation"),
    }
}

async fn validate_branch(cwd: &str, branch: &str) -> Result<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["check-ref-format", "--branch", branch])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("could not validate branch name")?;
    if !output.success() {
        bail!("invalid branch name");
    }
    Ok(())
}

async fn run(cwd: &str, args: &[String]) -> Result<Value> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("could not start git")?;
    let stdout = child.stdout.take().context("git stdout unavailable")?;
    let stderr = child.stderr.take().context("git stderr unavailable")?;
    let stdout_task = tokio::spawn(read_bounded(stdout));
    let stderr_task = tokio::spawn(read_bounded(stderr));

    let status = match timeout(COMMAND_TIMEOUT, child.wait()).await {
        Ok(status) => status.context("git process failed")?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            bail!("git operation timed out after 30 seconds");
        }
    };
    let (stdout, stdout_truncated) = stdout_task.await.context("git stdout task failed")??;
    let (stderr, stderr_truncated) = stderr_task.await.context("git stderr task failed")??;
    let output = combine_output(&stdout, &stderr);
    Ok(json!({
        "ok": status.success(),
        "exitCode": status.code(),
        "output": output,
        "truncated": stdout_truncated || stderr_truncated,
    }))
}

async fn read_bounded(mut reader: impl AsyncRead + Unpin) -> std::io::Result<(Vec<u8>, bool)> {
    let mut retained = Vec::new();
    let mut chunk = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let available = MAX_STREAM_BYTES.saturating_sub(retained.len());
        retained.extend_from_slice(&chunk[..read.min(available)]);
        truncated |= read > available;
    }
    Ok((retained, truncated))
}

fn combine_output(stdout: &[u8], stderr: &[u8]) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!(
            "{}\n{}",
            String::from_utf8_lossy(stdout).trim_end(),
            String::from_utf8_lossy(stderr).trim_end()
        ),
        (false, true) => String::from_utf8_lossy(stdout).trim_end().to_owned(),
        (true, false) => String::from_utf8_lossy(stderr).trim_end().to_owned(),
        (true, true) => String::new(),
    }
}

fn validate_text(label: &str, value: &str, max_bytes: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_bytes {
        bail!("{label} must contain between 1 and {max_bytes} bytes");
    }
    if value
        .bytes()
        .any(|byte| byte == 0 || byte < 0x20 || byte == 0x7f)
    {
        bail!("{label} contains control characters");
    }
    Ok(value.to_owned())
}

fn validate_path(value: &str) -> Result<()> {
    validate_text("path", value, 4096)?;
    let path = std::path::Path::new(value);
    if path.is_absolute() {
        bail!("git paths must be relative");
    }
    if value.starts_with(':') {
        bail!("git pathspec magic is not allowed");
    }
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("git paths cannot contain '..'");
    }
    Ok(())
}

fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
    values.into_iter().map(ToOwned::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn incoming(kind: &str, data: Value) -> Incoming {
        Incoming {
            request_id: Some("req-1".into()),
            kind: kind.into(),
            data: data.as_object().cloned().unwrap_or_else(Map::new),
        }
    }

    #[test]
    fn operations_build_argument_vectors_without_a_shell() {
        assert_eq!(
            arguments("git.status", &incoming("git.status", json!({}))).unwrap(),
            strings(["status", "--short", "--branch"])
        );
        assert_eq!(
            arguments(
                "git.commit",
                &incoming("git.commit", json!({ "message": "ship it" }))
            )
            .unwrap(),
            strings(["commit", "-m", "ship it"])
        );
        assert_eq!(
            arguments(
                "git.stage",
                &incoming("git.stage", json!({ "paths": ["src", "README.md"] }))
            )
            .unwrap(),
            strings(["add", "--", "src", "README.md"])
        );
    }

    #[test]
    fn rejects_control_text_traversal_absolute_and_magic_paths() {
        assert!(arguments(
            "git.commit",
            &incoming("git.commit", json!({ "message": "one\ntwo" }))
        )
        .is_err());
        for path in ["../secret", "/tmp/secret", ":(top)*"] {
            assert!(arguments(
                "git.stage",
                &incoming("git.stage", json!({ "paths": [path] }))
            )
            .is_err());
        }
    }
}
