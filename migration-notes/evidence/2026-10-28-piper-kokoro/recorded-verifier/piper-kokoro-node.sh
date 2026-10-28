set -eu
node --experimental-vm-modules tests/fixtures/piper_kokoro_reference.mjs --write /artifacts/piper-kokoro
node --experimental-vm-modules tests/fixtures/piper_kokoro_reference.mjs --check /artifacts/piper-kokoro
node --experimental-vm-modules tests/fixtures/piper_fetch_deadline_probe.mjs > /artifacts/piper-fetch-deadline.json
node tests/fixtures/fish_sdk_oracle.mjs --check /artifacts/fish-tts
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --check /artifacts/fish-tts
