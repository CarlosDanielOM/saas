node tests/fixtures/tts_source_resolver.test.cjs
node tests/fixtures/tts_utilities_reference.mjs --check
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --write /artifacts/tts-utility-retirement/expressive
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --check /artifacts/tts-utility-retirement/expressive
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --write /artifacts/tts-utility-retirement/credit
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --check /artifacts/tts-utility-retirement/credit
node tests/fixtures/channel_tts_settings_reference.mjs --write /artifacts/tts-utility-retirement/settings
node tests/fixtures/channel_tts_settings_reference.mjs --check /artifacts/tts-utility-retirement/settings
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --write /artifacts/tts-utility-retirement/fish
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --check /artifacts/tts-utility-retirement/fish
node --experimental-vm-modules tests/fixtures/piper_kokoro_reference.mjs --write /artifacts/tts-utility-retirement/piper-kokoro
node --experimental-vm-modules tests/fixtures/piper_kokoro_reference.mjs --check /artifacts/tts-utility-retirement/piper-kokoro
node tests/fixtures/tts_runtime_reference.mjs --write /artifacts/tts-utility-retirement/runtime
node tests/fixtures/tts_runtime_reference.mjs --check /artifacts/tts-utility-retirement/runtime
node --experimental-vm-modules tests/fixtures/tts_runtime_dynamic_reference.mjs --write /artifacts/tts-utility-retirement/runtime
node --experimental-vm-modules tests/fixtures/tts_runtime_dynamic_reference.mjs --check /artifacts/tts-utility-retirement/runtime
node tests/fixtures/tts_benchmark_prepare.cjs /artifacts/tts-utility-retirement/normalization-prepared
node tests/fixtures/expressive_tts_benchmark.mjs --write /artifacts/tts-utility-retirement/benchmark-tooling-smoke
node tests/fixtures/expressive_tts_benchmark.mjs --check /artifacts/tts-utility-retirement/benchmark-tooling-smoke
node /task-tools/tts_retirement_provenance.mjs
