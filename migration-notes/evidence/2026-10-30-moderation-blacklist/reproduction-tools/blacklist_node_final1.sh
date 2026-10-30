set -eu
export DIMA_JS_REGEXP_SOURCE_ROOT=/source/dimabot
export DIMA_JS_REGEXP_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/js_regexp_unicode_prepare.cjs --write /artifacts/moderation-blacklist/attempt1/core-reference
node tests/fixtures/js_regexp_unicode_prepare.cjs --check /artifacts/moderation-blacklist/attempt1/core-reference
export DIMA_CAPS_SOURCE_ROOT=/source/dimabot
export DIMA_CAPS_NODE_SHA256=$DIMA_JS_REGEXP_NODE_SHA256
node tests/fixtures/moderation_caps_unicode_prepare.cjs --write /artifacts/moderation-blacklist/attempt1/unicode-caps
node tests/fixtures/moderation_caps_unicode_prepare.cjs --check /artifacts/moderation-blacklist/attempt1/unicode-caps
export DIMA_CAPS_UNICODE_DIR=/artifacts/moderation-blacklist/attempt1/unicode-caps
export DIMA_CAPS_UNICODE_REFERENCE_SHA256=$(sha256sum /artifacts/moderation-blacklist/attempt1/unicode-caps/unicode-reference.json | cut -d ' ' -f1)
node tests/fixtures/moderation_caps_reference.cjs --write /artifacts/moderation-blacklist/attempt1/caps-reference
node tests/fixtures/moderation_caps_reference.cjs --check /artifacts/moderation-blacklist/attempt1/caps-reference
export DIMA_BLACKLIST_SOURCE_ROOT=/source/dimabot
node tests/fixtures/moderation_blacklist_reference.cjs --write /artifacts/moderation-blacklist/attempt1/reference
node tests/fixtures/moderation_blacklist_reference.cjs --check /artifacts/moderation-blacklist/attempt1/reference
node tests/fixtures/moderation_blacklist_benchmark.cjs --write /artifacts/moderation-blacklist/attempt1/benchmark
node tests/fixtures/moderation_blacklist_benchmark.cjs --check /artifacts/moderation-blacklist/attempt1/benchmark
