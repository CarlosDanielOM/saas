#!/bin/sh
set -eu
cd /source/dimabot
. /task-tools/fish_favorites_benchmark_env3.sh
node tests/fixtures/fish_favorite_alias_benchmark.cjs --run "$DIMA_FISH_ALIAS_DIR"
