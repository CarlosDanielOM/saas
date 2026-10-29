set -eu
export DIMA_CAPS_SOURCE_ROOT=/source/dimabot
export DIMA_CAPS_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_CAPS_UNICODE_DIR=/artifacts/moderation-caps/unicode-initial
node tests/fixtures/moderation_caps_reference.cjs --write /artifacts/moderation-caps/attempt2/reference
node tests/fixtures/moderation_caps_reference.cjs --check /artifacts/moderation-caps/attempt2/reference
export DIMA_JS_UNICODE_SOURCE_ROOT=/source/dimabot
export DIMA_JS_UNICODE_NODE_SHA256="$DIMA_CAPS_NODE_SHA256"
node /task-tools/js_unicode17_prepare.cjs --write /artifacts/js-unicode17/initial
node /task-tools/js_unicode17_prepare.cjs --check /artifacts/js-unicode17/initial
