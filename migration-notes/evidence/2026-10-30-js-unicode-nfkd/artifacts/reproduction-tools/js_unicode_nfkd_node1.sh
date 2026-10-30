#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/js-unicode-nfkd/attempt1
mkdir -p "$base/nfkd" "$base/nfc"
export DIMA_JS_UNICODE_SOURCE_ROOT=/source/dimabot
export DIMA_JS_UNICODE_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/js_unicode_nfkd_reference.cjs --write "$base/nfkd"
node tests/fixtures/js_unicode_nfkd_reference.cjs --check "$base/nfkd"
node tests/fixtures/js_unicode_nfc_reference.cjs --write "$base/nfc"
node tests/fixtures/js_unicode_nfc_reference.cjs --check "$base/nfc"
