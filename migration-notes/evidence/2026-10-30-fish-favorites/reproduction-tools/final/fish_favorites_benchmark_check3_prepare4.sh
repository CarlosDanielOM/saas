#!/bin/sh
set -eu
cd /source/dimabot
. /task-tools/fish_favorites_benchmark_env3.sh
export DIMA_FISH_ALIAS_NODE_SHA256=280a40b66b53d88bc1fd513fcfd9b8ba2b868267d54a14e1db622efe2fef8198
export DIMA_FISH_ALIAS_RUST_SHA256=05f549444f6f20ce2773d9a9a3707408465c109b60e6c4d18e1ecea217fdf5b0
node tests/fixtures/fish_favorite_alias_benchmark.cjs --check "$DIMA_FISH_ALIAS_DIR"

mkdir -p /artifacts/fish-favorites/confirmation4/benchmark
node tests/fixtures/fish_favorite_alias_benchmark.cjs --prepare /artifacts/fish-favorites/confirmation4/benchmark
