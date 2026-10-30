set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features js-regexp-unicode --test js_regexp_unicode
cargo test --locked --offline --no-default-features --features moderation-blacklist,moderation-caps --test moderation_blacklist --test moderation_caps
cargo clippy --locked --offline --no-default-features --features js-regexp-unicode --all-targets -- -D warnings
cargo clippy --locked --offline --no-default-features --features moderation-blacklist,moderation-caps --all-targets -- -D warnings
