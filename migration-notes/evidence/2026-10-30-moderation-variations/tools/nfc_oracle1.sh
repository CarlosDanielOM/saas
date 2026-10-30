set -eu
export DIMA_JS_UNICODE_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_JS_UNICODE_SOURCE_ROOT=/source/dimabot
export DIMA_JS_NFC_ORACLE_SHA256=449e3f81f3b01c0e37a3c5ebdb2e547ca8c0d29a6770356aa18da119a4493ed5
mkdir -p /artifacts/js-unicode-nfc/attempt1/reference
node tests/fixtures/js_unicode_nfc_reference.cjs --write /artifacts/js-unicode-nfc/attempt1/reference
node tests/fixtures/js_unicode_nfc_reference.cjs --check /artifacts/js-unicode-nfc/attempt1/reference
