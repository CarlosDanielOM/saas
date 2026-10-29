set -eu
export TZ=UTC
node tests/fixtures/ai_usage_receipt_parser_benchmark.cjs --check /artifacts/receipt-parser-benchmark/attempt1/benchmark
