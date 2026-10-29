node tests/fixtures/tts_runtime_reference.mjs --write /artifacts/tts-runtime
node tests/fixtures/tts_runtime_reference.mjs --check /artifacts/tts-runtime
node --experimental-vm-modules tests/fixtures/tts_runtime_dynamic_reference.mjs --write /artifacts/tts-runtime
node --experimental-vm-modules tests/fixtures/tts_runtime_dynamic_reference.mjs --check /artifacts/tts-runtime
node /task-tools/tts_runtime_fixture_provenance.mjs
