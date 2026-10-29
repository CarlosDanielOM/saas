node tests/fixtures/tts_lossless_reference.cjs --write /artifacts/tts-lossless-normalization/reference
node tests/fixtures/tts_lossless_reference.cjs --check /artifacts/tts-lossless-normalization/reference
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --check /artifacts/tts-utility-retirement/expressive
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --check /artifacts/tts-utility-retirement/credit
node tests/fixtures/tts_lossless_benchmark.cjs --write /artifacts/tts-lossless-normalization/benchmark
node tests/fixtures/tts_lossless_benchmark.cjs --check /artifacts/tts-lossless-normalization/benchmark
node /task-tools/tts_lossless_provenance.cjs
