//! Pinned node-RE2 1.27.0 Unicode facts, independent of Rust regex Unicode data.
//!
//! Native RE2 categories/scripts and wrapper binary/script-extension tables are
//! separate namespaces with different provenance. Native tables do not declare
//! a Unicode version. The wrapper header declares Unicode 17.0. This module
//! handles raw code point facts, including surrogate ranges; it does not encode
//! JS strings, decode UTF-8, parse regex syntax, or implement matching.
//!
//! Derived table licenses: tests/fixtures/re2-source-licenses/.

use super::re2_unicode_data::{BINARY, BUILTIN, CASE_FOLD, CATEGORY_ALIASES, SCRIPT_EXTENSIONS};

/// Inclusive raw code point range. Bounds may include U+D800..U+DFFF.
pub type Range = (u32, u32);

/// Distinguishes tables that the SDK resolves through different branches.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Namespace {
    /// Native RE2 short categories and long script names; includes special Any.
    Builtin,
    /// Wrapper binary property names and their checked aliases.
    Binary,
    /// Wrapper Script_Extensions/scx values and their checked aliases.
    ScriptExtensions,
}

/// A checked, positive property table. Negation and folding belong to callers.
#[derive(Clone, Copy, Debug)]
pub struct Property {
    pub namespace: Namespace,
    pub name: &'static str,
    pub ranges: &'static [Range],
}

impl Property {
    /// Raw membership; invalid code point values are always false.
    pub fn contains(self, cp: u32) -> bool {
        if cp > 0x10ffff {
            return false;
        }
        let i = self.ranges.partition_point(|&(_, end)| end < cp);
        self.ranges.get(i).is_some_and(|&(start, _)| start <= cp)
    }
}

fn tables(namespace: Namespace) -> &'static [(&'static str, &'static [Range])] {
    match namespace {
        Namespace::Builtin => BUILTIN,
        Namespace::Binary => BINARY,
        Namespace::ScriptExtensions => SCRIPT_EXTENSIONS,
    }
}

/// All accepted names in one namespace, in byte-sorted order.
pub fn properties(namespace: Namespace) -> impl ExactSizeIterator<Item = Property> {
    tables(namespace)
        .iter()
        .map(move |&(name, ranges)| Property {
            namespace,
            name,
            ranges,
        })
}

/// Case-sensitive lookup in exactly one namespace, without wrapper rewriting.
pub fn lookup(namespace: Namespace, name: &str) -> Option<Property> {
    let entries = tables(namespace);
    let index = entries.binary_search_by_key(&name, |&(key, _)| key).ok()?;
    let (name, ranges) = entries[index];
    Some(Property {
        namespace,
        name,
        ranges,
    })
}

/// Resolved property plus native leading-caret negation (before `\\P` inversion).
#[derive(Clone, Copy, Debug)]
pub struct ResolvedProperty {
    pub property: Property,
    pub inverted: bool,
}

/// Resolve the contents of a braced SDK property escape, following pattern.cc.
///
/// Prefixes/aliases are case-sensitive. Script=/sc= strips its prefix before
/// native lookup, so it does not accept the wrapper's short script aliases.
/// This is name resolution only; syntax validation remains with the parser.
pub fn resolve_braced(name: &str) -> Option<ResolvedProperty> {
    if let Some(value) = strip(name, &["Script_Extensions=", "scx="])
        && let Some(property) = lookup(Namespace::ScriptExtensions, value)
    {
        return Some(ResolvedProperty {
            property,
            inverted: false,
        });
    }
    let name = strip(name, &["General_Category=", "gc="]).unwrap_or(name);
    if let Some(property) = lookup(Namespace::Binary, name) {
        return Some(ResolvedProperty {
            property,
            inverted: false,
        });
    }
    let name = CATEGORY_ALIASES
        .binary_search_by_key(&name, |&(key, _)| key)
        .map_or_else(
            |_| strip(name, &["Script=", "sc="]).unwrap_or(name),
            |i| CATEGORY_ALIASES[i].1,
        );
    let (name, inverted) = name.strip_prefix('^').map_or((name, false), |n| (n, true));
    lookup(Namespace::Builtin, name).map(|property| ResolvedProperty { property, inverted })
}

fn strip<'a>(name: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    prefixes
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix).filter(|value| !value.is_empty()))
}

/// Next member in native RE2's simple fold cycle, wrapping the largest to first.
/// Unmapped values (including invalid code points) are returned unchanged.
pub fn fold_next(cp: u32) -> u32 {
    let i = CASE_FOLD.partition_point(|&(_, end, _)| end < cp);
    let Some(&(start, _, delta)) = CASE_FOLD.get(i).filter(|&&(start, _, _)| start <= cp) else {
        return cp;
    };
    match delta {
        1 => cp ^ 1,
        -1 => {
            if cp & 1 == 1 {
                cp + 1
            } else {
                cp - 1
            }
        }
        1_073_741_824 | 1_073_741_825 if (cp - start) & 1 == 1 => cp,
        1_073_741_824 => cp ^ 1,
        1_073_741_825 => {
            if cp & 1 == 1 {
                cp + 1
            } else {
                cp - 1
            }
        }
        _ => (i64::from(cp) + i64::from(delta)) as u32,
    }
}

/// Iterate every member exactly once, starting at the supplied code point.
pub fn equivalents(cp: u32) -> FoldEquivalents {
    FoldEquivalents {
        first: cp,
        next: Some(cp),
    }
}

#[derive(Clone, Debug)]
pub struct FoldEquivalents {
    first: u32,
    next: Option<u32>,
}

impl Iterator for FoldEquivalents {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        let cp = self.next?;
        let next = fold_next(cp);
        self.next = (next != self.first).then_some(next);
        Some(cp)
    }
}

impl std::iter::FusedIterator for FoldEquivalents {}
