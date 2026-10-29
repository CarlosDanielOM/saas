mkdir -p /artifacts/emotes-normalizer-retirement/tts-utilities
cp tests/fixtures/tts_utilities_cases.json /artifacts/emotes-normalizer-retirement/tts-utilities/tts_utilities_cases.json
node tests/fixtures/tts_source_resolver.test.cjs
node tests/fixtures/tts_utilities_reference.mjs --write /artifacts/emotes-normalizer-retirement/tts-utilities/tts_utilities_cases.json
node tests/fixtures/tts_utilities_reference.mjs --check /artifacts/emotes-normalizer-retirement/tts-utilities/tts_utilities_cases.json
node tests/fixtures/tts_lossless_reference.cjs --write /artifacts/emotes-normalizer-retirement/lossless
node tests/fixtures/tts_lossless_reference.cjs --check /artifacts/emotes-normalizer-retirement/lossless
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --write /artifacts/emotes-normalizer-retirement/expressive
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --check /artifacts/emotes-normalizer-retirement/expressive
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --write /artifacts/emotes-normalizer-retirement/credit
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --check /artifacts/emotes-normalizer-retirement/credit
node tests/fixtures/channel_tts_settings_reference.mjs --write /artifacts/emotes-normalizer-retirement/settings
node tests/fixtures/channel_tts_settings_reference.mjs --check /artifacts/emotes-normalizer-retirement/settings
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --write /artifacts/emotes-normalizer-retirement/fish
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --check /artifacts/emotes-normalizer-retirement/fish
node --experimental-vm-modules tests/fixtures/piper_kokoro_reference.mjs --write /artifacts/emotes-normalizer-retirement/piper-kokoro
node --experimental-vm-modules tests/fixtures/piper_kokoro_reference.mjs --check /artifacts/emotes-normalizer-retirement/piper-kokoro
node tests/fixtures/tts_runtime_reference.mjs --write /artifacts/emotes-normalizer-retirement/runtime
node tests/fixtures/tts_runtime_reference.mjs --check /artifacts/emotes-normalizer-retirement/runtime
node --experimental-vm-modules tests/fixtures/tts_runtime_dynamic_reference.mjs --write /artifacts/emotes-normalizer-retirement/runtime
node --experimental-vm-modules tests/fixtures/tts_runtime_dynamic_reference.mjs --check /artifacts/emotes-normalizer-retirement/runtime
node tests/fixtures/tts_benchmark_prepare.cjs /artifacts/emotes-normalizer-retirement/normalization-prepared
node tests/fixtures/tts_lossless_benchmark.cjs --write /artifacts/emotes-normalizer-retirement/benchmark-tooling-smoke
node tests/fixtures/tts_lossless_benchmark.cjs --check /artifacts/emotes-normalizer-retirement/benchmark-tooling-smoke
node tests/fixtures/twitch_emotes_reference.cjs --write /artifacts/emotes-normalizer-retirement/emotes
node tests/fixtures/twitch_emotes_reference.cjs --check /artifacts/emotes-normalizer-retirement/emotes
node /task-tools/emotes_retirement_provenance.cjs
