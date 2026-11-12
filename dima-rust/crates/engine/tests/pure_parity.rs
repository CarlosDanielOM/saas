//! The pure-function corpus (`fixtures/ast_pure_cases.json`, 5,522 cases generated from today's
//! TypeScript by `fixtures/ast_pure_reference.mjs` under Node 24) run against the engine's
//! builtins. Same rules as `evaluator_parity.rs`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

#[test]
fn pure_corpus_matches_the_reference() {
    let tally = support::run_corpus("ast_pure_cases.json");
    println!("{tally:#?}");
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
