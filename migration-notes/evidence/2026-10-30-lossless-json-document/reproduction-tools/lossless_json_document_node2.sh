#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
base=/artifacts/lossless-json-document/attempt2
mkdir -p "$base/document" "$base/parser" "$base/queries"
node tests/fixtures/lossless_json_document_reference.cjs --write "$base/document"
node tests/fixtures/lossless_json_document_reference.cjs --check "$base/document"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --write "$base/parser"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$base/parser"
node /task-tools/copy_json_document_dependencies.cjs "$base/parser/ai_usage_receipt_parser_reference.json" "$base/parser-provenance"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --write "$base/queries"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --check "$base/queries"
node /task-tools/copy_json_document_dependencies.cjs "$base/queries/ai_usage_ledger_queries_reference.json" "$base/queries-provenance"
