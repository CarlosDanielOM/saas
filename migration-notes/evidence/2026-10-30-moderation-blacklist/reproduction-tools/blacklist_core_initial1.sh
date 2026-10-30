set -eu
export DIMA_JS_REGEXP_SOURCE_ROOT=/source/dimabot
export DIMA_JS_REGEXP_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/js_regexp_unicode_prepare.cjs --write /artifacts/moderation-blacklist/attempt1/core-initial
node tests/fixtures/js_regexp_unicode_prepare.cjs --check /artifacts/moderation-blacklist/attempt1/core-initial
