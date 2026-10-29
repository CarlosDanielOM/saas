set -eu
export TZ=UTC
mkdir -p /artifacts/receipt-parser-benchmark/attempt2/parser
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --write /artifacts/receipt-parser-benchmark/attempt2/parser
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check /artifacts/receipt-parser-benchmark/attempt2/parser
