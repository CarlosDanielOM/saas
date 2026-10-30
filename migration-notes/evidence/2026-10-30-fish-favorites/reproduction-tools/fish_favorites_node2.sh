#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/fish-favorites/attempt2/oracle
mkdir -p "$base"
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --write "$base"
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --check "$base"
