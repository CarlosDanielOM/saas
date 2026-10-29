node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --write /artifacts/tts-value-adapters
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --check /artifacts/tts-value-adapters
node /task-tools/tts_values_provenance.mjs
