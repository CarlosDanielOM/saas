set -eu
export TZ=UTC
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check /artifacts/receipt-parser-benchmark/attempt4/parser
node tests/fixtures/ai_usage_receipt_parser_benchmark.cjs --check /artifacts/receipt-parser-benchmark/attempt4/benchmark
