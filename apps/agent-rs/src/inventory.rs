use crate::{
    config::Config,
    herdr,
    protocol::{DirectoryRoot, InventorySnapshot, RuntimeInventory},
    tmux,
};
use std::sync::atomic::{AtomicU64, Ordering};

static REVISION: AtomicU64 = AtomicU64::new(0);

pub struct Collector {
    herdr: Option<RuntimeInventory>,
    tmux: Option<RuntimeInventory>,
}

impl Collector {
    pub fn new() -> Self {
        Self {
            herdr: None,
            tmux: None,
        }
    }

    pub async fn initialize(&mut self, config: &Config) -> InventorySnapshot {
        let (next_herdr, next_tmux) = tokio::join!(herdr::inventory(), tmux::inventory());
        self.herdr = Some(next_herdr);
        self.tmux = Some(next_tmux);
        self.snapshot(config)
    }

    pub async fn refresh_all(&mut self, config: &Config) -> Option<InventorySnapshot> {
        let (next_herdr, next_tmux) = tokio::join!(herdr::inventory(), tmux::inventory());
        let changed =
            self.herdr.as_ref() != Some(&next_herdr) || self.tmux.as_ref() != Some(&next_tmux);
        self.herdr = Some(next_herdr);
        self.tmux = Some(next_tmux);
        changed.then(|| self.snapshot(config))
    }

    pub async fn refresh_herdr(&mut self, config: &Config) -> Option<InventorySnapshot> {
        let next = herdr::inventory().await;
        let changed = self.herdr.as_ref() != Some(&next);
        self.herdr = Some(next);
        if self.tmux.is_none() {
            self.tmux = Some(tmux::inventory().await);
        }
        changed.then(|| self.snapshot(config))
    }

    pub async fn refresh_tmux(&mut self, config: &Config) -> Option<InventorySnapshot> {
        let next = tmux::inventory().await;
        let changed = self.tmux.as_ref() != Some(&next);
        self.tmux = Some(next);
        if self.herdr.is_none() {
            self.herdr = Some(herdr::inventory().await);
        }
        changed.then(|| self.snapshot(config))
    }

    pub fn snapshot(&self, config: &Config) -> InventorySnapshot {
        InventorySnapshot {
            revision: REVISION.fetch_add(1, Ordering::Relaxed) + 1,
            roots: roots(config),
            runtimes: vec![
                self.herdr.clone().unwrap_or(RuntimeInventory::Herdr {
                    available: false,
                    sessions: Vec::new(),
                }),
                self.tmux.clone().unwrap_or(RuntimeInventory::Tmux {
                    available: false,
                    sessions: Vec::new(),
                }),
            ],
        }
    }

    pub fn tmux(&self) -> Option<&RuntimeInventory> {
        self.tmux.as_ref()
    }
}

fn roots(config: &Config) -> Vec<DirectoryRoot> {
    config
        .roots
        .iter()
        .map(|(key, path)| DirectoryRoot {
            key: key.clone(),
            path: path.to_string_lossy().into_owned(),
            writable: true,
        })
        .collect()
}

pub async fn collect(config: &Config) -> InventorySnapshot {
    let (herdr, tmux) = tokio::join!(herdr::inventory(), tmux::inventory());
    InventorySnapshot {
        revision: REVISION.fetch_add(1, Ordering::Relaxed) + 1,
        roots: roots(config),
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
