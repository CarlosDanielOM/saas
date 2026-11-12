//! The identities one scan has seen, which the missing-relationship sweep must leave alone.
//!
//! Held in memory, as the reference holds them, but compactly and under a limit. A Twitch id is
//! a decimal number and is kept as one (about a dozen bytes each, so a million followers cost
//! some megabytes); any other text is kept as it is. A scan that would pass the limit fails
//! before its sweep, so nothing is ended on incomplete knowledge.
use crate::Error;
use std::collections::HashSet;

pub(crate) struct Seen {
    numbers: HashSet<u64>,
    others: HashSet<Box<str>>,
    limit: usize,
}
impl Seen {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            numbers: HashSet::new(),
            others: HashSet::new(),
            limit,
        }
    }
    pub(crate) fn add(&mut self, id: &str) -> Result<(), Error> {
        if self.contains(id) {
            return Ok(());
        }
        if self.numbers.len() + self.others.len() >= self.limit {
            return Err(Error::ScanTooLarge { limit: self.limit });
        }
        match number(id) {
            Some(n) => self.numbers.insert(n),
            None => self.others.insert(id.into()),
        };
        Ok(())
    }
    pub(crate) fn contains(&self, id: &str) -> bool {
        match number(id) {
            Some(n) => self.numbers.contains(&n),
            None => self.others.contains(id),
        }
    }
}

/// The number an id spells, when the id is exactly that number's decimal form: `"7"` is 7,
/// while `"07"`, `"+7"` and `"7 "` are other identities and stay text.
fn number(id: &str) -> Option<u64> {
    let canonical = !id.is_empty()
        && id.len() <= 20
        && (id.len() == 1 || !id.starts_with('0'))
        && id.bytes().all(|b| b.is_ascii_digit());
    if canonical { id.parse().ok() } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_that_differ_as_text_stay_different() -> Result<(), Error> {
        let mut seen = Seen::new(16);
        for id in [
            "7",
            "07",
            "+7",
            "7 ",
            "seven",
            "18446744073709551615",
            "18446744073709551616",
        ] {
            assert!(!seen.contains(id), "{id:?} before it was added");
            seen.add(id)?;
            assert!(seen.contains(id), "{id:?}");
        }
        assert!(!seen.contains("007"));
        assert!(!seen.contains(""));
        Ok(())
    }

    #[test]
    fn the_limit_counts_distinct_ids() -> Result<(), Error> {
        let mut seen = Seen::new(2);
        seen.add("1")?;
        seen.add("a")?;
        seen.add("1")?;
        assert!(matches!(
            seen.add("2"),
            Err(Error::ScanTooLarge { limit: 2 })
        ));
        assert!(!seen.contains("2"));
        Ok(())
    }
}
