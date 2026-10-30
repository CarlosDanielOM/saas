set -eu
cargo fmt --all -- --check
cargo check --locked --offline --no-default-features --features re2-strings,re2-unicode --all-targets
cargo test --locked --offline --no-default-features --features re2-strings,re2-unicode --test re2_string --test re2_unicode
export DIMA_RE2_CODEC_RECEIPT_DIR=/artifacts/moderation-advanced/codec-probe/reference
export DIMA_RE2_CODEC_RECEIPT_SHA256=a5a92da501dfaa4e78098ee0b8a5e97367cbe7bd1d6dd5dcf0a281c2ed077f31
cargo test --locked --offline --no-default-features --features re2-strings --test re2_string replay_pinned_node24_codec_probe -- --ignored --exact
export DIMA_RE2_UNICODE_FIXTURE_DIR=/artifacts/moderation-advanced/unicode-attempt2
export DIMA_RE2_UNICODE_FIXTURE_SHA256=eac8a1d8ca6767065407a5835f6aeb724911d9007ab36dfd09592972c459e443
export DIMA_RE2_UNICODE_SDK_SOURCE_DIR=/artifacts/moderation-advanced/re2-node24/re2
cargo test --locked --offline --no-default-features --features re2-unicode --test re2_unicode external_cpp_facts_and_sdk_checks_replay -- --ignored --exact
cargo test --locked --offline --no-default-features --features js-strings --lib
cargo clippy --locked --offline --no-default-features --features re2-strings,re2-unicode,moderation-advanced-policy --all-targets -- -D warnings
