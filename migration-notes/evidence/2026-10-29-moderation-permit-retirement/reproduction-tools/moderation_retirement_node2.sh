set -eu
/usr/local/bin/node tests/fixtures/moderation_source_resolver.test.cjs
export DIMA_CAPS_SOURCE_ROOT=/source/dimabot
export DIMA_CAPS_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_CAPS_UNICODE_DIR=/artifacts/moderation-rule-retirement/attempt1/unicode
export DIMA_CAPS_UNICODE_REFERENCE_SHA256=a4c0cd830198fc9edc47c90707805a7e9078bf2f1184a6800d01b6a263f2c95e
/usr/local/bin/node tests/fixtures/moderation_caps_unicode_prepare.cjs --check /artifacts/moderation-rule-retirement/attempt1/unicode
/usr/local/bin/node tests/fixtures/moderation_caps_reference.cjs --write /artifacts/moderation-rule-retirement/attempt2/caps-reference
/usr/local/bin/node tests/fixtures/moderation_caps_reference.cjs --check /artifacts/moderation-rule-retirement/attempt2/caps-reference
export DIMA_EMOTE_SPAM_SOURCE_ROOT=/source/dimabot
export DIMA_EMOTE_SPAM_NODE_SHA256="$DIMA_CAPS_NODE_SHA256"
/usr/local/bin/node tests/fixtures/moderation_emote_spam_reference.cjs --write /artifacts/moderation-rule-retirement/attempt2/emote-reference
/usr/local/bin/node tests/fixtures/moderation_emote_spam_reference.cjs --check /artifacts/moderation-rule-retirement/attempt2/emote-reference
export DIMA_PERMIT_SOURCE_ROOT=/source/dimabot
export DIMA_PERMIT_NODE_SHA256="$DIMA_CAPS_NODE_SHA256"
/usr/local/bin/node tests/fixtures/moderation_permit_reference.cjs --write /artifacts/moderation-rule-retirement/attempt2/permit-reference
/usr/local/bin/node tests/fixtures/moderation_permit_reference.cjs --check /artifacts/moderation-rule-retirement/attempt2/permit-reference
