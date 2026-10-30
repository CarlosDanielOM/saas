set -eu
mkdir -p /artifacts/fish-review/attempt1/oracle
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --write /artifacts/fish-review/attempt1/oracle
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --check /artifacts/fish-review/attempt1/oracle
