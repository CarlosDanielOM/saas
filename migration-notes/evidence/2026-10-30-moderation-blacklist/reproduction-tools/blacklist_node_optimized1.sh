set -eu
export DIMA_JS_REGEXP_SOURCE_ROOT=/source/dimabot
node tests/fixtures/js_regexp_unicode_prepare.cjs --write /artifacts/moderation-blacklist/attempt2/core-reference
node tests/fixtures/js_regexp_unicode_prepare.cjs --check /artifacts/moderation-blacklist/attempt2/core-reference
export DIMA_BLACKLIST_SOURCE_ROOT=/source/dimabot
node tests/fixtures/moderation_blacklist_reference.cjs --write /artifacts/moderation-blacklist/attempt2/reference
node tests/fixtures/moderation_blacklist_reference.cjs --check /artifacts/moderation-blacklist/attempt2/reference
node tests/fixtures/moderation_blacklist_benchmark.cjs --write /artifacts/moderation-blacklist/attempt2/benchmark
node tests/fixtures/moderation_blacklist_benchmark.cjs --check /artifacts/moderation-blacklist/attempt2/benchmark
