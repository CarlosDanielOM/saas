node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --check /artifacts/expressive-tts
node tests/fixtures/expressive_tts_benchmark.mjs --check /artifacts/expressive-tts
node /task-tools/expressive_fixture_provenance.mjs
