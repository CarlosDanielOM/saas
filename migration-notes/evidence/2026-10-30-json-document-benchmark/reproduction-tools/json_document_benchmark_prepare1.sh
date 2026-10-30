#!/bin/sh
set -eu
cd /source/dimabot
mkdir -p /artifacts/json-document-benchmark/round1
node tests/fixtures/lossless_json_document_benchmark.cjs --prepare /artifacts/json-document-benchmark/round1
