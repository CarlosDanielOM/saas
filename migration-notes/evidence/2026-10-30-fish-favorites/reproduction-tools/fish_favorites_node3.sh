#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/fish-favorites/attempt3
mkdir -p "$base/oracle" "$base/benchmark"
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --write "$base/oracle"
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --check "$base/oracle"
export DIMA_FISH_ALIAS_RUSTC_PROVENANCE_PATH=/artifacts/fish-favorites/toolchain/rustc.json
export DIMA_FISH_ALIAS_RUSTC_PROVENANCE_SHA256=3e05ac673a05e508be9fcc8e23966d10a5b833243fb23a52041dcc6dd4590736
node tests/fixtures/fish_favorite_alias_benchmark.cjs --prepare "$base/benchmark"
