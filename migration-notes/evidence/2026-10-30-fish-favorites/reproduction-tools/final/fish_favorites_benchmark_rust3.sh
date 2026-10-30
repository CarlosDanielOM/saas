#!/bin/sh
set -eu
cd /source/dimabot
. /task-tools/fish_favorites_benchmark_env3.sh
cargo test --release --locked --offline --no-default-features --features channel-fish-voice-favorites --test fish_favorite_alias_benchmark matched_fish_alias_benchmark -- --ignored --exact --nocapture
