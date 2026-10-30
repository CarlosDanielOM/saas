set -eu
node --check tests/fixtures/ai_credit_reader_reference.cjs
mkdir -p /artifacts/ai-credit-reader/attempt1/reference
node tests/fixtures/ai_credit_reader_reference.cjs > /artifacts/ai-credit-reader/attempt1/reference/reference.json
node tests/fixtures/ai_credit_reader_reference.cjs > /artifacts/ai-credit-reader/attempt1/reference/check.json
cmp /artifacts/ai-credit-reader/attempt1/reference/reference.json /artifacts/ai-credit-reader/attempt1/reference/check.json
sha256sum /artifacts/ai-credit-reader/attempt1/reference/reference.json
