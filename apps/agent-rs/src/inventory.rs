use crate::{
    config::Config,
    herdr,
    protocol::{DirectoryRoot, InventorySnapshot, RuntimeInventory},
    tmux,
};
use std::sync::atomic::{AtomicU64, Ordering};

static REVISION: AtomicU64 = AtomicU64::new(0);

pub async fn collect(config: &Config) -> InventorySnapshot {
    let (herdr, tmux) = tokio::join!(herdr::inventory(), tmux::inventory());
    let roots = config
        .roots
        .iter()
        .map(|(key, path)| DirectoryRoot {
            key: key.clone(),
            path: path.to_string_lossy().into_owned(),
            writable: true,
        })
        .collect();
    InventorySnapshot {
        revision: REVISION.fetch_add(1, Ordering::Relaxed) + 1,
        roots,
        runtimes: vec![herdr, tmux],
    }
}

pub fn runtime_available(snapshot: &InventorySnapshot, kind: &str) -> bool {
    snapshot.runtimes.iter().any(|runtime| match runtime {
        RuntimeInventory::Herdr { available, .. } if kind == "herdr" => *available,
        RuntimeInventory::Tmux { available, .. } if kind == "tmux" => *available,
        _ => false,
    })
}
