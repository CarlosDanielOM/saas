set -eu
export DIMA_JS_REGEXP_UNICODE_FIXTURE_DIR=/artifacts/moderation-blacklist/attempt1/core-reference
export DIMA_JS_REGEXP_UNICODE_FIXTURE_SHA256=e0374c942603059ee5b220d51628c74c5dd430bd0cae0077842412164b6cc26b
export DIMA_MODERATION_BLACKLIST_FIXTURE_DIR=/artifacts/moderation-blacklist/attempt1/reference3
export DIMA_MODERATION_BLACKLIST_FIXTURE_SHA256=590272c51cdd39bd64ef1f1b153f43e15825806da2fc0b045130d48b039b71fb
export DIMA_CAPS_REFERENCE_DIR=/artifacts/moderation-blacklist/attempt1/caps-reference
cargo test --locked --offline --no-default-features --features moderation-blacklist,moderation-caps --test js_regexp_unicode --test moderation_blacklist --test moderation_caps -- --ignored --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
cargo test --release --locked --offline --no-default-features --features moderation-blacklist --test moderation_blacklist_benchmark --no-run --message-format=json > /artifacts/moderation-blacklist/attempt1/benchmark-build.jsonl
