#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/fish-favorites/optimized3
mkdir -p "$base/oracle" "$base/benchmark"
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --write "$base/oracle"
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --check "$base/oracle"
export DIMA_FISH_ALIAS_RUSTC_PROVENANCE_PATH=/artifacts/fish-favorites/toolchain/rustc.json
export DIMA_FISH_ALIAS_RUSTC_PROVENANCE_SHA256=3e05ac673a05e508be9fcc8e23966d10a5b833243fb23a52041dcc6dd4590736
node tests/fixtures/fish_favorite_alias_benchmark.cjs --prepare "$base/benchmark"

mkdir -p "$base/ascii-lower" "$base/nfkd" "$base/nfc"
node tests/fixtures/js_unicode_ascii_lower_reference.cjs --write "$base/ascii-lower"
node tests/fixtures/js_unicode_ascii_lower_reference.cjs --check "$base/ascii-lower"
export DIMA_JS_UNICODE_SOURCE_ROOT=/source/dimabot
export DIMA_JS_UNICODE_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/js_unicode_nfkd_reference.cjs --write "$base/nfkd"
node tests/fixtures/js_unicode_nfkd_reference.cjs --check "$base/nfkd"
export DIMA_JS_NFC_ORACLE_SHA256=449e3f81f3b01c0e37a3c5ebdb2e547ca8c0d29a6770356aa18da119a4493ed5
node tests/fixtures/js_unicode_nfc_reference.cjs --write "$base/nfc"
node tests/fixtures/js_unicode_nfc_reference.cjs --check "$base/nfc"
