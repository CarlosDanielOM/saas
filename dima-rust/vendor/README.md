# Vendored crates

Third-party crates the workspace carries with a small set of local changes. Upstream is not ours
to wait for; each change here is listed with its reason and the test that shows it.

## What is here

| Directory | Crate | Version | Checksum of the published `.crate` (as `Cargo.lock` had it) | Upstream commit (`.cargo_vcs_info.json`) |
|---|---|---|---|---|
| `engineioxide/` | `engineioxide` | 0.17.7 | `0235543b6e1a5fef2a8a7871ae410d5d1c440d8ced9217ec0f1b344edfe30673` | `708ea9fc5ee549229d7236924e4975ec5977a59c`, `crates/engineioxide` |
| `engineioxide-core/` | `engineioxide-core` | 0.2.2 | `06c5f98b2d2338ec0713bc222c753bfd18746bd76cbb115afa18aa07c6096553` | `511e6e8a525b8047bd9c5bc8199578b014044f85`, `crates/engineioxide-core` |

Source: crates.io, <https://github.com/totodore/socketioxide>. The first commit that added this
directory holds the two packages exactly as published (every file of the `.crate` archives); every
later commit touching it is one numbered change below.

**Licence.** Both crates are MIT (`license = "MIT"` in their `Cargo.toml`). The published packages
contain no licence file, so none could be copied from them; upstream's `LICENSE` is at the root of
the repository at the commits above. It has to be added next to each crate before any of this is
distributed outside the company (open question for the lead; it was not fetched here).

## How it is wired

- `dima-rust/Cargo.toml` has `[patch.crates-io]` entries for both crates, so every crate of the
  workspace uses these copies (`dima-socketio`, and `socketioxide` of the root crate's `socketio`
  feature, which depends on `engineioxide` too).
- The main workspace excludes `vendor/` (`exclude = ["vendor"]`): the crates are not members, so
  the workspace lints, `tools/check --all`, `cargo fmt --all` and `clippy --workspace` leave them
  alone. They keep upstream's own `[lints]`.
- `vendor/Cargo.toml` is a small workspace of their own, with its own `Cargo.lock` (seeded from
  the main lock file, so the versions are the ones production builds with), to run their tests,
  whose dev-dependencies the main lock file does not carry. Upstream's unit tests of
  `engineioxide-core` only compile with its `v3` feature, so the tests run with all features:

  ```sh
  cd dima-rust/vendor
  ../tools/cargo test --locked --offline --all-features
  ../tools/cargo clippy --locked --offline --all-features --all-targets
  ../tools/cargo fmt --all -- --check     # upstream's code is rustfmt-clean; keep it so
  ```

  Cargo warns twice that the `resolver` key of the members is ignored: that key is upstream's.

## Rules for changing it

- Change only what a numbered entry below needs. No reformatting, no renaming, no tidying: every
  line that differs from upstream must belong to an entry, so the difference can be audited.
- Every entry says what changed, why (the `engine.io` 6.6.9 source it matches, when it is about
  behaviour), and which test shows it. A test fails before the change and passes after it.
- New code: no `unwrap`, `expect`, `panic!` or byte slicing of text on any path that network input
  can reach, and no `unsafe`.
- Upgrading upstream: start from the new published packages in a commit of their own, then re-apply
  each entry that is still needed, and update this file.

## Seeing the difference from upstream

Against the registry copy that Cargo extracted (`.cargo-ok` is Cargo's marker, not a package file):

```sh
cd dima-rust/vendor
diff -ru -x .cargo-ok ~/.cargo/registry/src/index.crates.io-*/engineioxide-0.17.7 engineioxide
diff -ru -x .cargo-ok ~/.cargo/registry/src/index.crates.io-*/engineioxide-core-0.2.2 engineioxide-core
```

or with Git, from the commit that added the untouched copy:

```sh
git log --oneline -- dima-rust/vendor          # the first entry is the untouched copy
git diff <that commit> -- dima-rust/vendor
```

## Changes

0. **Manifest: no benchmarks.** `engineioxide/Cargo.toml`: the two `[[bench]]` targets and the
   `criterion` (`codspeed-criterion-compat`) dev-dependency are removed. Cargo resolves every
   dev-dependency to run any test, and that one is not in the local registry (it would pull a
   large tree for benchmarks nobody runs here). The bench sources stay in `benches/`.
