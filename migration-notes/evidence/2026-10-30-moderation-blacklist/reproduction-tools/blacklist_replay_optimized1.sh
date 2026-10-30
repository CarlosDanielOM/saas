set -eu
export DIMA_JS_REGEXP_UNICODE_FIXTURE_DIR=/artifacts/moderation-blacklist/attempt2/core-reference
export DIMA_JS_REGEXP_UNICODE_FIXTURE_SHA256=3873b6d263563f1598c560d23106914afc24e0b38d9c9471074720afd438c7bd
export DIMA_MODERATION_BLACKLIST_FIXTURE_DIR=/artifacts/moderation-blacklist/attempt2/reference
export DIMA_MODERATION_BLACKLIST_FIXTURE_SHA256=6ec11ae503801b2bd5cfc810118e8008e2fdc1e18bee02a8c1940fb58c589d39
export DIMA_CAPS_REFERENCE_DIR=/artifacts/moderation-blacklist/attempt1/caps-reference
cargo test --locked --offline --no-default-features --features moderation-blacklist,moderation-caps --test js_regexp_unicode --test moderation_blacklist --test moderation_caps -- --ignored --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
cargo test --release --locked --offline --no-default-features --features moderation-blacklist --test moderation_blacklist_benchmark --no-run --message-format=json > /artifacts/moderation-blacklist/attempt2/benchmark-build.jsonl
