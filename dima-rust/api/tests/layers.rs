//! The dependency rules of the upper layers (`ledger/upper-layers.md` section 2.3), checked on
//! the workspace's manifests as `cargo metadata` reports them, so that a later package cannot
//! add a wrong edge unnoticed:
//!
//! - every crate has a layer, and every crate of the upper layers (and every binary) depends
//!   only on crates of a lower layer, or on a crate of its own layer where the crate map lists
//!   that edge (`dima-features` on `dima-engine`, `dima-routes` on `dima-site-agent`);
//! - `dima-bot` never links `dima-realtime`, `dima-services`, `dima-routes`, `dima-site-agent`,
//!   `dima-recap` or `dima-event-handlers`, at any depth;
//! - `dima-event-handlers` and `dima-features` never link `dima-actions`, at any depth (they
//!   reach chat through `dima_twitch::chat::ChatOut`), and `dima-moderation` never links it
//!   either (the host's moderation functions call it, not the other way);
//! - once `cron/` exists (P2-CRON-01), `dima-cron` never links `dima-chat`, `dima-realtime`,
//!   `dima-routes`, `dima-site-agent` or `dima-services`.
//!
//! Only normal dependencies count: a test may use a crate above it (`dima-event-handlers` tests
//! may use the real `ChatDelivery`). Dependencies outside the workspace are not checked here.

use anyhow::{Context, bail};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;

/// Every crate of the workspace and its layer (`packages.md` crate map, `upper-layers.md`
/// section 2.3). The pre-existing root crate, the rig and the small services are outside the
/// layer rules.
const LAYERS: &[(&str, u8)] = &[
    ("dima-text", 0),
    ("dima-core", 1),
    ("dima-store", 1),
    ("dima-telemetry", 2),
    ("dima-http", 2),
    ("dima-web", 2),
    ("dima-socketio", 2),
    ("dima-model", 3),
    ("dima-twitch", 4),
    ("dima-events", 4),
    ("dima-billing", 4),
    ("dima-email", 4),
    ("dima-stream", 5),
    ("dima-tts", 5),
    ("dima-ai", 5),
    ("dima-commands", 5),
    ("dima-platform", 5),
    ("dima-engine", 6),
    ("dima-moderation", 6),
    ("dima-features", 6),
    ("dima-actions", 7),
    ("dima-chat", 8),
    ("dima-realtime", 8),
    ("dima-services", 8),
    ("dima-event-handlers", 8),
    ("dima-recap", 8),
    ("dima-site-agent", 9),
    ("dima-routes", 9),
    ("dima-server", 10),
    ("dima-bot", 10),
    ("dima-cron", 10),
];

/// Outside the layer rules.
const UNLAYERED: &[&str] = &[
    "dima-rust",
    "dima-rig",
    "dima-analytics",
    "dimadb-server",
    "dimafx-server",
    "dima-hoststats",
];

/// The crates whose every edge is checked against the layers: P4-SKEL's and the binaries.
const UPPER: &[&str] = &[
    "dima-moderation",
    "dima-features",
    "dima-actions",
    "dima-chat",
    "dima-realtime",
    "dima-services",
    "dima-event-handlers",
    "dima-recap",
    "dima-site-agent",
    "dima-routes",
    "dima-server",
    "dima-bot",
    "dima-cron",
];

/// Same-layer edges the crate map lists.
const SAME_LAYER: &[(&str, &str)] = &[
    ("dima-features", "dima-engine"),
    ("dima-routes", "dima-site-agent"),
];

/// Crates that must never be linked from a crate, at any depth.
const FORBIDDEN: &[(&str, &[&str])] = &[
    (
        "dima-bot",
        &[
            "dima-realtime",
            "dima-services",
            "dima-routes",
            "dima-site-agent",
            "dima-recap",
            "dima-event-handlers",
        ],
    ),
    ("dima-event-handlers", &["dima-actions"]),
    ("dima-features", &["dima-actions"]),
    ("dima-moderation", &["dima-actions"]),
    (
        "dima-cron",
        &[
            "dima-chat",
            "dima-realtime",
            "dima-routes",
            "dima-site-agent",
            "dima-services",
        ],
    ),
];

/// Each workspace package and its normal dependencies on other workspace packages.
fn workspace_graph() -> anyhow::Result<BTreeMap<String, BTreeSet<String>>> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("workspace root")?;
    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--offline",
        ])
        .current_dir(root)
        .output()?;
    if !output.status.success() {
        bail!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let metadata: Value = serde_json::from_slice(&output.stdout)?;
    let packages = metadata["packages"].as_array().context("packages")?;
    let names: BTreeSet<String> = packages
        .iter()
        .filter_map(|package| package["name"].as_str().map(str::to_owned))
        .collect();
    let mut graph = BTreeMap::new();
    for package in packages {
        let name = package["name"].as_str().context("name")?.to_owned();
        let dependencies = package["dependencies"]
            .as_array()
            .context("dependencies")?
            .iter()
            .filter(|dependency| dependency["kind"].is_null())
            .filter_map(|dependency| dependency["name"].as_str())
            .filter(|dependency| names.contains(*dependency))
            .map(str::to_owned)
            .collect();
        graph.insert(name, dependencies);
    }
    Ok(graph)
}

fn layer(name: &str) -> Option<u8> {
    LAYERS
        .iter()
        .find(|(crate_name, _)| *crate_name == name)
        .map(|(_, layer)| *layer)
}

/// Everything `from` links, at any depth (normal dependencies).
fn reachable(graph: &BTreeMap<String, BTreeSet<String>>, from: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![from.to_owned()];
    while let Some(current) = stack.pop() {
        for next in graph.get(&current).into_iter().flatten() {
            if seen.insert(next.clone()) {
                stack.push(next.clone());
            }
        }
    }
    seen
}

#[test]
fn every_crate_has_a_layer() -> anyhow::Result<()> {
    let graph = workspace_graph()?;
    let missing: Vec<&String> = graph
        .keys()
        .filter(|name| layer(name).is_none() && !UNLAYERED.contains(&name.as_str()))
        .collect();
    if !missing.is_empty() {
        bail!("crates without a layer in api/tests/layers.rs: {missing:?}");
    }
    for name in ["dima-server", "dima-bot", "dima-routes", "dima-actions"] {
        anyhow::ensure!(graph.contains_key(name), "{name} is not a workspace member");
    }
    Ok(())
}

#[test]
fn the_upper_layers_depend_only_downwards() -> anyhow::Result<()> {
    let graph = workspace_graph()?;
    let mut wrong = Vec::new();
    for name in UPPER {
        let Some(dependencies) = graph.get(*name) else {
            continue; // dima-cron, before P2-CRON-01 creates it.
        };
        let own = layer(name).context("upper crate without a layer")?;
        for dependency in dependencies {
            let allowed = match layer(dependency) {
                Some(theirs) => {
                    theirs < own
                        || (theirs == own && SAME_LAYER.contains(&(*name, dependency.as_str())))
                }
                None => false,
            };
            if !allowed {
                wrong.push(format!("{name} -> {dependency}"));
            }
        }
    }
    anyhow::ensure!(wrong.is_empty(), "edges that do not point down: {wrong:?}");
    Ok(())
}

#[test]
fn forbidden_crates_are_never_linked() -> anyhow::Result<()> {
    let graph = workspace_graph()?;
    let mut wrong = Vec::new();
    for (name, forbidden) in FORBIDDEN {
        if !graph.contains_key(*name) {
            continue; // dima-cron, before P2-CRON-01 creates it.
        }
        let linked = reachable(&graph, name);
        for crate_name in *forbidden {
            if linked.contains(*crate_name) {
                wrong.push(format!("{name} links {crate_name}"));
            }
        }
    }
    anyhow::ensure!(wrong.is_empty(), "{wrong:?}");
    // The rules have teeth: the API does link what the bot must not.
    let api = reachable(&graph, "dima-server");
    for crate_name in ["dima-realtime", "dima-routes", "dima-chat", "dima-actions"] {
        anyhow::ensure!(
            api.contains(crate_name),
            "dima-server does not link {crate_name}"
        );
    }
    let bot = reachable(&graph, "dima-bot");
    for crate_name in [
        "dima-chat",
        "dima-actions",
        "dima-features",
        "dima-moderation",
    ] {
        anyhow::ensure!(
            bot.contains(crate_name),
            "dima-bot does not link {crate_name}"
        );
    }
    Ok(())
}
