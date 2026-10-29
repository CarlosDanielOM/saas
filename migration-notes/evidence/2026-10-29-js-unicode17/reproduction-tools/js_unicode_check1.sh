set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features js-unicode17 --all-targets -- -D warnings
cargo test --locked --offline --no-default-features --features js-unicode17 --test js_unicode
