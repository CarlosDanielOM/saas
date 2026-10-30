#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/js-unicode-nfkd/attempt1
export JS_NFKD_ORACLE="$base/nfkd/js_unicode_nfkd.json"
export JS_NFKD_ORACLE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["JS_NFKD_ORACLE"],"rb").read()).hexdigest())')"
export DIMA_JS_NFC_DIR="$base/nfc"
export DIMA_JS_NFC_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_JS_NFC_DIR"]+"/js-unicode-nfc-reference.json","rb").read()).hexdigest())')"
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfkd --test js_unicode_nfc --test js_unicode
cargo test --release --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfkd pinned_node_all_scalar_and_mixed_nfkd -- --ignored --exact
cargo test --release --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfc replay_all_codepoints_and_contexts_from_pinned_node -- --ignored --exact
cargo clippy --locked --offline --no-default-features --features js-unicode17 --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
