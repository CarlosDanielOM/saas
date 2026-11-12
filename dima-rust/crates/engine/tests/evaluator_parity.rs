//! The evaluator corpus (`fixtures/ast_evaluator_cases.json`, 4,139 cases generated from today's
//! TypeScript by `fixtures/ast_evaluator_reference.mjs` under Node 24) run against
//! `dima_engine::eval`. Every case must give the recorded observation, with the intended
//! differences of [`support::Difference`] applied; the cases whose input cannot exist in Rust
//! ([`support::Unrepresentable`]) are counted.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

#[test]
fn evaluator_corpus_matches_the_reference() {
    let tally = support::run_corpus("ast_evaluator_cases.json");
    println!("{tally:#?}");
    // Every intended difference, by the number of cases it changes.
    use support::Difference::*;
    let expected = [
        (CharacterCount, 1),
        (CodePointOrder, 8),
        (LoneSurrogateEscape, 11),
        (SnapshotCopy, 1),
        (JsonNesting, 26),
    ];
    assert_eq!(
        tally.differences,
        expected.into_iter().collect(),
        "the intended differences changed"
    );
    assert!(
        tally.failures.is_empty(),
        "{} cases differ:\n{}",
        tally.failures.len(),
        tally
            .failures
            .iter()
            .take(12)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
