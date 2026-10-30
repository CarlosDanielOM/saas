#!/bin/sh
set -eu
cd /source/dimabot
cargo test --locked --offline --no-default-features --features twitch-functions --test token_storage_lifecycle --test token_storage_parity
