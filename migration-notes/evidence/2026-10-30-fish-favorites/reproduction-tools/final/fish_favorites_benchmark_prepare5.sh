#!/bin/sh
set -eu
cd /source/dimabot
. /task-tools/fish_favorites_benchmark_env5.sh
mkdir -p "$DIMA_FISH_ALIAS_DIR"
node tests/fixtures/fish_favorite_alias_benchmark.cjs --prepare "$DIMA_FISH_ALIAS_DIR"
