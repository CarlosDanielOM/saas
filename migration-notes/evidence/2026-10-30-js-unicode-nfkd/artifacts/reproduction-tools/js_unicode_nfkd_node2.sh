#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/js-unicode-nfkd/attempt2
mkdir -p "$base/nfkd" "$base/nfc"
export DIMA_JS_UNICODE_SOURCE_ROOT=/source/dimabot
export DIMA_JS_UNICODE_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/js_unicode_nfkd_reference.cjs --write "$base/nfkd"
node tests/fixtures/js_unicode_nfkd_reference.cjs --check "$base/nfkd"
export DIMA_JS_NFC_ORACLE_SHA256=449e3f81f3b01c0e37a3c5ebdb2e547ca8c0d29a6770356aa18da119a4493ed5
node tests/fixtures/js_unicode_nfc_reference.cjs --write "$base/nfc"
node tests/fixtures/js_unicode_nfc_reference.cjs --check "$base/nfc"
