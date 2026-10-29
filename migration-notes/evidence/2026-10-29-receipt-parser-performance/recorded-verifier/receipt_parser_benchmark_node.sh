set -eu
export TZ=UTC
mkdir -p /artifacts/receipt-parser-benchmark/attempt1
node tests/fixtures/ai_usage_receipt_parser_benchmark.cjs --write /artifacts/receipt-parser-benchmark/attempt1/benchmark
