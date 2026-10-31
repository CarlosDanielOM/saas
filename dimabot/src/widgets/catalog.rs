//! Dead by Daylight overlay catalogue.
//!
//! Ports `dimabot/src/widgets/catalog.ts`. The pack list is the six legacy
//! `dbd-{role}-{mode}` ids already-open OBS sources still request. Entry
//! rows and `researchedAt` come from `dbd.json` (`researched_at`
//! `2026-10-08T04:14:23+00:00` in the current dataset). Parsing is lazy and
//! fallible: importing this module does not read the network or panic.

#![cfg(feature = "widgets-runtime")]

use serde::{Deserialize, Serialize};
use std::{fmt, sync::OnceLock};

/// Killer or survivor. Wire values are the source strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Killer,
    Survivor,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Killer => "killer",
            Self::Survivor => "survivor",
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Pack mode. `poll` is an operation, not a pack id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Challenge,
    Characters,
    Perks,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Challenge => "challenge",
            Self::Characters => "characters",
            Self::Perks => "perks",
        }
    }
}

/// One catalogue row from `dbd.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub english: String,
    pub spanish: String,
    pub image_url: String,
    pub role: String,
    pub kind: String,
    pub available: bool,
}

/// A legacy OBS pack id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pack {
    pub id: String,
    pub game: String,
    pub role: Role,
    pub mode: Mode,
}

/// Control-center widget card. `roles` is omitted for duel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WidgetCard {
    pub id: &'static str,
    pub game: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<&'static [&'static str]>,
}

/// `{ widgets, packs, entries, researchedAt }` in that key order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Catalog {
    pub widgets: Vec<WidgetCard>,
    pub packs: Vec<Pack>,
    pub entries: Vec<Entry>,
    #[serde(rename = "researchedAt")]
    pub researched_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogError {
    pub message: String,
}

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CatalogError {}

#[derive(Deserialize)]
struct CatalogFile {
    researched_at: String,
    entries: Vec<Entry>,
}

fn load() -> &'static Result<Catalog, CatalogError> {
    static CATALOG: OnceLock<Result<Catalog, CatalogError>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let file: CatalogFile = serde_json::from_str(include_str!("dbd.json")).map_err(|error| {
            CatalogError {
                message: format!("Widget catalog JSON is invalid: {error}"),
            }
        })?;
        let mut packs = Vec::with_capacity(6);
        for role in [Role::Killer, Role::Survivor] {
            for mode in [Mode::Challenge, Mode::Characters, Mode::Perks] {
                packs.push(Pack {
                    id: format!("dbd-{}-{}", role.as_str(), mode.as_str()),
                    game: "Dead by Daylight".to_owned(),
                    role,
                    mode,
                });
            }
        }
        Ok(Catalog {
            widgets: vec![
                WidgetCard {
                    id: "dbd-challenge",
                    game: "Dead by Daylight",
                    roles: Some(&["killer", "survivor"]),
                },
                WidgetCard {
                    id: "duel",
                    game: "Chat duel",
                    roles: None,
                },
            ],
            packs,
            entries: file.entries,
            researched_at: file.researched_at,
        })
    })
}

/// Parsed catalogue. The first call parses the embedded JSON; later calls reuse it.
pub fn catalog() -> Result<&'static Catalog, CatalogError> {
    load().as_ref().map_err(Clone::clone)
}

/// Entry rows, in dataset order.
pub fn entries() -> Result<&'static [Entry], CatalogError> {
    catalog().map(|catalog| catalog.entries.as_slice())
}

/// The six legacy pack ids.
pub fn packs() -> Result<&'static [Pack], CatalogError> {
    catalog().map(|catalog| catalog.packs.as_slice())
}

/// `dbd.researched_at`, exposed as `researchedAt`.
pub fn researched_at() -> Result<&'static str, CatalogError> {
    catalog().map(|catalog| catalog.researched_at.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_and_research_timestamp_match_the_dataset() {
        let catalog = catalog().expect("catalog");
        assert_eq!(researched_at().expect("time"), "2026-10-08T04:14:23+00:00");
        assert_eq!(
            catalog.packs.iter().map(|pack| pack.id.as_str()).collect::<Vec<_>>(),
            vec![
                "dbd-killer-challenge",
                "dbd-killer-characters",
                "dbd-killer-perks",
                "dbd-survivor-challenge",
                "dbd-survivor-characters",
                "dbd-survivor-perks",
            ]
        );
        assert_eq!(catalog.widgets[0].id, "dbd-challenge");
        assert_eq!(catalog.widgets[1].game, "Chat duel");
        assert!(catalog.entries.iter().any(|entry| entry.kind == "perk" && entry.role == "killer"));
    }
}
