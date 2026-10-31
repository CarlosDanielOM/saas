# team4 static review tooling (no toolchain required)

Two read-only Python audits used by the team4 lead to review authored Rust without
running cargo. They read files only; they never build, run or modify anything.

    python3 path_audit.py '<json groups>'   # unresolved crate:: paths / missing items
    python3 trait_audit.py '<json groups>'  # public trait without a concrete adapter

`<json groups>` maps a group name to a list of .rs files:

    {"lane-a-speech": ["src/speech/*.rs"], "lane-c-media": ["src/media/*.rs"]}

path_audit resolves `crate::` paths through lib.rs `#[path = "..."]` module aliases,
through `pub mod X;` children, and through glob re-exports (`pub use types::*;`).
trait_audit strips the `#[cfg(test)] mod tests` block before counting adapters, so a
test double never counts as a production adapter.

These are heuristics, not a compiler. They found no unresolved paths and no
adapter-less trait in lanes A, C and D at the time of the review; Lane B's
`crate::widgets_runtime::*` and `crate::roulette_runtime::*` references are
expected to resolve only after the central patch adds the crate-root aliases.
