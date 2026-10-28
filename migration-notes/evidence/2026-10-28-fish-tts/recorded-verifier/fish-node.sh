set -eu
node tests/fixtures/fish_sdk_oracle.mjs --write /artifacts/fish-tts
node tests/fixtures/fish_sdk_oracle.mjs --check /artifacts/fish-tts
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --write /artifacts/fish-tts
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --check /artifacts/fish-tts
FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts FISH_MSGPACK_BENCH_OUTPUT=/artifacts/fish-tts/node-benchmark.json node tests/fixtures/fish_msgpack_benchmark.mjs
