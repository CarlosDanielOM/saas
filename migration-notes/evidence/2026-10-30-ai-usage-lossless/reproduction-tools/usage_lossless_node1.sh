set -eu
node --check tests/fixtures/ai_usage_lossless_reference.cjs
mkdir -p /artifacts/ai-usage-lossless/attempt1/reference
node tests/fixtures/ai_usage_lossless_reference.cjs --write /artifacts/ai-usage-lossless/attempt1/reference
node tests/fixtures/ai_usage_lossless_reference.cjs --check /artifacts/ai-usage-lossless/attempt1/reference
sha256sum /artifacts/ai-usage-lossless/attempt1/reference/ai_usage_lossless_reference.json
