//! Allowances: explicit, per-path exceptions to "every difference counts", each with a reason.
//! An allowance that matched nothing is reported as a warning so stale ones get removed.

use std::cell::Cell;

use regex::Regex;

use crate::path::{Path, Pattern};

#[derive(Debug, Clone)]
pub enum AllowKind {
    /// The value at the path is not compared (presence included).
    Ignore,
    /// The array at the path is compared as a multiset (order does not matter).
    Set,
    /// Times (and plain numbers) at the path compare within this many milliseconds (units).
    Tolerance(i64),
    /// The value at the path is generated at run time (a random token): it becomes a numbered
    /// placeholder. With a pattern, every match of the pattern inside strings and key names at or
    /// below the path becomes a placeholder.
    Generated(Option<Regex>),
}

impl AllowKind {
    pub fn name(&self) -> &'static str {
        match self {
            AllowKind::Ignore => "ignore",
            AllowKind::Set => "set",
            AllowKind::Tolerance(_) => "tolerance",
            AllowKind::Generated(_) => "generated",
        }
    }
}

#[derive(Debug)]
pub struct Allowance {
    pub path: Pattern,
    pub kind: AllowKind,
    pub reason: String,
    used: Cell<bool>,
}

#[derive(Debug, Default)]
pub struct Allowances {
    list: Vec<Allowance>,
}

impl Allowances {
    pub fn new(list: Vec<(Pattern, AllowKind, String)>) -> Allowances {
        Allowances {
            list: list
                .into_iter()
                .map(|(path, kind, reason)| Allowance {
                    path,
                    kind,
                    reason,
                    used: Cell::new(false),
                })
                .collect(),
        }
    }

    fn find(
        &self,
        path: &Path,
        mark: bool,
        want: impl Fn(&AllowKind) -> bool,
    ) -> Option<&Allowance> {
        let a = self
            .list
            .iter()
            .find(|a| want(&a.kind) && a.path.matches(path))?;
        if mark {
            a.used.set(true);
        }
        Some(a)
    }

    pub fn ignored(&self, path: &Path, mark: bool) -> bool {
        self.find(path, mark, |k| matches!(k, AllowKind::Ignore))
            .is_some()
    }

    pub fn is_set(&self, path: &Path, mark: bool) -> bool {
        self.find(path, mark, |k| matches!(k, AllowKind::Set))
            .is_some()
    }

    pub fn tolerance(&self, path: &Path, mark: bool) -> Option<i64> {
        match self
            .find(path, mark, |k| matches!(k, AllowKind::Tolerance(_)))?
            .kind
        {
            AllowKind::Tolerance(ms) => Some(ms),
            _ => None,
        }
    }

    /// A whole-value `generated` allowance matches this exact path.
    pub fn generated_whole(&self, path: &Path) -> bool {
        self.find(path, true, |k| matches!(k, AllowKind::Generated(None)))
            .is_some()
    }

    /// Patterns of `generated` allowances that apply at or above this path.
    pub fn generated_patterns(&self, path: &Path) -> Vec<(usize, &Regex)> {
        self.list
            .iter()
            .enumerate()
            .filter_map(|(i, a)| match &a.kind {
                AllowKind::Generated(Some(re)) if a.path.matches_self_or_ancestor(path) => {
                    Some((i, re))
                }
                _ => None,
            })
            .collect()
    }

    pub fn mark_used(&self, index: usize) {
        if let Some(a) = self.list.get(index) {
            a.used.set(true);
        }
    }

    pub fn any_generated_patterns(&self) -> bool {
        self.list
            .iter()
            .any(|a| matches!(a.kind, AllowKind::Generated(Some(_))))
    }

    pub fn unused(&self) -> impl Iterator<Item = &Allowance> {
        self.list.iter().filter(|a| !a.used.get())
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }
}
