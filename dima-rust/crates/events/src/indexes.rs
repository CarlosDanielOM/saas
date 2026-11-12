//! The unique indexes a writer of this crate stands on.
//!
//! The journal, the delivery fan-out and the cron-job intents know "already done" from a
//! duplicate key: without the unique index, two writers would both insert and the work would
//! happen twice. The reference awaits `Model.init()` before those writes. Here every constructor
//! that writes such a collection takes the startup [`IndexReport`] and checks, itself, that each
//! unique index the collection **declares** is in the report and was not refused, whatever
//! policy built the report: a report built with [`dima_model::index::IndexPolicy::BestEffort`]
//! marks no index as required, and an index left out of the report was never ensured, so neither
//! may let a writer start.

use dima_model::IndexReport;
use dima_model::index::{IndexSpec, IndexStatus, RequiredIndexError};

/// `Ok` when every unique index `declared` for `collection` is in `report` and was not refused.
pub fn require_unique(
    report: &IndexReport,
    collection: &'static str,
    declared: &[IndexSpec],
) -> Result<(), RequiredIndexError> {
    let missing: Vec<String> = if report.collection != collection {
        vec![format!("no index report (got {})", report.collection)]
    } else {
        declared
            .iter()
            .filter(|spec| spec.unique)
            .filter_map(|spec| {
                let name = spec.name();
                match report.outcomes.iter().find(|o| o.index == name) {
                    Some(outcome) => match &outcome.status {
                        IndexStatus::Failed(error) => Some(format!("{name}: {error}")),
                        IndexStatus::Exists | IndexStatus::Created => None,
                    },
                    None => Some(format!("{name}: not in the report")),
                }
            })
            .collect()
    };
    if missing.is_empty() {
        Ok(())
    } else {
        Err(RequiredIndexError {
            collection,
            missing,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_model::index::{IndexError, IndexOutcome};
    use std::time::Duration;

    fn report(collection: &'static str, outcomes: Vec<(&str, bool, IndexStatus)>) -> IndexReport {
        IndexReport {
            collection,
            outcomes: outcomes
                .into_iter()
                .map(|(index, required, status)| IndexOutcome {
                    index: index.to_owned(),
                    required,
                    status,
                })
                .collect(),
        }
    }

    const DECLARED: &[IndexSpec] = &[
        IndexSpec::on(&[("a", 1)]),
        IndexSpec::on(&[("b", 1), ("c", 1)]).unique(),
        IndexSpec::on(&[("d", 1)]).unique(),
    ];

    #[test]
    fn every_declared_unique_index_must_be_there() {
        let ok = report(
            "x",
            vec![
                (
                    "a_1",
                    false,
                    IndexStatus::Failed(IndexError::Deadline(Duration::ZERO)),
                ),
                ("b_1_c_1", true, IndexStatus::Exists),
                ("d_1", true, IndexStatus::Created),
            ],
        );
        assert!(
            require_unique(&ok, "x", DECLARED).is_ok(),
            "a plain index may fail"
        );

        // A lenient report: the unique index failed but was not marked required.
        let lenient = report(
            "x",
            vec![
                (
                    "b_1_c_1",
                    false,
                    IndexStatus::Failed(IndexError::Deadline(Duration::ZERO)),
                ),
                ("d_1", false, IndexStatus::Exists),
            ],
        );
        let error = require_unique(&lenient, "x", DECLARED).err();
        assert!(error.is_some_and(|e| e.missing.len() == 1 && e.missing[0].starts_with("b_1_c_1")));

        // An entry missing from the report.
        let partial = report("x", vec![("b_1_c_1", true, IndexStatus::Exists)]);
        let error = require_unique(&partial, "x", DECLARED).err();
        assert!(error.is_some_and(|e| e.missing == ["d_1: not in the report"]));

        // Another collection's report.
        assert!(require_unique(&ok, "y", DECLARED).is_err());
    }
}
