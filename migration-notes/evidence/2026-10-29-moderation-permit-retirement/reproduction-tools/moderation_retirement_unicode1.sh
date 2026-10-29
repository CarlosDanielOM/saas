set -eu
/usr/local/bin/node tests/fixtures/moderation_source_resolver.test.cjs
export DIMA_CAPS_SOURCE_ROOT=/source/dimabot
export DIMA_CAPS_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
/usr/local/bin/node tests/fixtures/moderation_caps_unicode_prepare.cjs --write /artifacts/moderation-rule-retirement/attempt1/unicode
/usr/local/bin/node tests/fixtures/moderation_caps_unicode_prepare.cjs --check /artifacts/moderation-rule-retirement/attempt1/unicode
