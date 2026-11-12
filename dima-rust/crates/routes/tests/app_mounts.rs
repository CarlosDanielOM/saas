//! The mount table against the inventory of every route of the reference (`ledger/http.json`,
//! made by walking the TypeScript): each router entry carries a guard for every kind of
//! authentication its routes use, and a router whose routes all need one never lists
//! `Guard::Public` alone. A router mounted without its guard fails here before it fails in
//! production (where a handler that asks for an identity no guard attached answers 500).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_routes::mounts::{Guard, MOUNTS, What};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn inventory() -> Value {
    let path = format!("{}/../../ledger/http.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Router files mounted by another router file rather than by `server.ts`.
fn parent_of(file: &str) -> &str {
    match file {
        "server/routes/stream_timeline.route.ts" => "server/routes/analytics.route.ts",
        "server/routes/duel-widget.route.ts" => "server/routes/widgets.route.ts",
        other => other,
    }
}

/// The two OAuth routers share one file: they are told apart by their prefix.
fn key(file: &str, path: Option<&str>) -> String {
    if file != "server/oauth/routes.ts" {
        return file.to_owned();
    }
    let prefix = path
        .unwrap_or_default()
        .split('/')
        .nth(1)
        .unwrap_or_default();
    format!("{file}#/{prefix}")
}

/// Whether `guards` covers routes whose reference authentication is `kind`.
fn covers(guards: &[Guard], kind: &str) -> bool {
    guards.iter().any(|guard| match kind {
        "none" => matches!(guard, Guard::Public),
        "bearer session" => matches!(guard, Guard::User | Guard::BrowserUser),
        "oauth access token" => matches!(guard, Guard::OAuthToken),
        "admin" => matches!(guard, Guard::WorkspaceOwner | Guard::GlobalAdmin),
        "service token" => matches!(guard, Guard::ServiceToken(_)),
        "signed webhook" => matches!(guard, Guard::WebhookSignature),
        // Capability URLs, the activation JWT, the mock sign-in secret, the sign-in code.
        "other" => matches!(
            guard,
            Guard::Capability | Guard::ServiceToken(_) | Guard::Upstream | Guard::Undecided(_)
        ),
        _ => panic!("unknown authentication kind {kind}"),
    })
}

#[test]
fn every_router_has_the_guards_its_routes_need() {
    let inventory = inventory();
    let mut kinds: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for route in inventory["routes"].as_array().unwrap() {
        if route["app"] != "api" {
            continue;
        }
        let file = route["file"]
            .as_str()
            .unwrap()
            .trim_start_matches("dimabot/src/");
        let path = route["path"].as_str().unwrap();
        kinds
            .entry(key(parent_of(file), Some(path)))
            .or_default()
            .insert(route["auth"].as_str().unwrap().to_owned());
    }
    for terminal in inventory["terminalUse"].as_array().unwrap() {
        let file = terminal["file"]
            .as_str()
            .unwrap()
            .trim_start_matches("dimabot/src/");
        let path = terminal["path"].as_str().unwrap();
        kinds
            .entry(key(file, Some(path)))
            .or_default()
            .insert(terminal["auth"].as_str().unwrap().to_owned());
    }
    let mut checked = BTreeSet::new();
    for mount in &MOUNTS {
        let (file, guards) = match mount.what {
            What::Router(file) => (key(file.source(), mount.path), mount.guards),
            What::Route(_) => (key("server/server.ts", mount.path), mount.guards),
            What::Middleware(_) => {
                assert!(mount.guards.is_empty(), "{}", mount.reference);
                continue;
            }
        };
        let needed = kinds
            .get(&file)
            .unwrap_or_else(|| panic!("{file} has no routes in the inventory"));
        for kind in needed {
            assert!(
                covers(guards, kind),
                "{} ({file}) has {kind} routes but no guard for them: {guards:?}",
                mount.reference
            );
        }
        // Public only where the reference has public routes; never as the only guard of a
        // router whose routes all authenticate.
        if guards.contains(&Guard::Public) {
            assert!(
                needed.contains("none"),
                "{} lists Guard::Public without public routes",
                mount.reference
            );
        }
        if needed.iter().any(|kind| kind != "none") {
            assert!(
                guards.iter().any(|guard| *guard != Guard::Public),
                "{} authenticates but lists no guard",
                mount.reference
            );
        }
        checked.insert(file);
    }
    let unmounted: Vec<&String> = kinds
        .keys()
        .filter(|file| !checked.contains(*file) && !file.starts_with("bot/"))
        .collect();
    assert!(
        unmounted.is_empty(),
        "routes of {unmounted:?} are not in the mount table"
    );
}

/// The speech router's guard waits for the owner (plan question 7.1) and stays undecided.
#[test]
fn the_speech_guard_stays_undecided() {
    let speech = MOUNTS
        .iter()
        .find(|mount| mount.path == Some("/speech"))
        .unwrap();
    assert!(
        speech
            .guards
            .iter()
            .any(|guard| matches!(guard, Guard::Undecided(_)))
    );
}
