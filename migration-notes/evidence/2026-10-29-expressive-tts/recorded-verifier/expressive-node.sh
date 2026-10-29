node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --write /artifacts/expressive-tts
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --check /artifacts/expressive-tts
node tests/fixtures/expressive_tts_benchmark.mjs --write /artifacts/expressive-tts
node tests/fixtures/expressive_tts_benchmark.mjs --check /artifacts/expressive-tts
node /task-tools/tts_runtime_fixture_provenance.mjs
