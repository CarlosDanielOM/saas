set -eu
node tests/fixtures/moderation_source_resolver.test.cjs
export DIMA_CAPS_SOURCE_ROOT=/source/dimabot
export DIMA_CAPS_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/moderation_caps_unicode_prepare.cjs --write /artifacts/moderation-seed-retirement/attempt1/unicode
node tests/fixtures/moderation_caps_unicode_prepare.cjs --check /artifacts/moderation-seed-retirement/attempt1/unicode
export DIMA_CAPS_UNICODE_DIR=/artifacts/moderation-seed-retirement/attempt1/unicode
export DIMA_CAPS_UNICODE_REFERENCE_SHA256=$(sha256sum /artifacts/moderation-seed-retirement/attempt1/unicode/unicode-reference.json | cut -d ' ' -f1)
node tests/fixtures/moderation_caps_reference.cjs --write /artifacts/moderation-seed-retirement/attempt1/caps-reference
node tests/fixtures/moderation_caps_reference.cjs --check /artifacts/moderation-seed-retirement/attempt1/caps-reference
export DIMA_EMOTE_SPAM_SOURCE_ROOT=/source/dimabot
export DIMA_EMOTE_SPAM_NODE_SHA256=$DIMA_CAPS_NODE_SHA256
node tests/fixtures/moderation_emote_spam_reference.cjs --write /artifacts/moderation-seed-retirement/attempt1/emote-reference
node tests/fixtures/moderation_emote_spam_reference.cjs --check /artifacts/moderation-seed-retirement/attempt1/emote-reference
export DIMA_SEED_PLAN_SOURCE_ROOT=/source/dimabot
export DIMA_SEED_PLAN_NODE_SHA256=$DIMA_CAPS_NODE_SHA256
node tests/fixtures/moderation_seed_plan_reference.cjs --write /artifacts/moderation-seed-retirement/attempt1/seed-reference
node tests/fixtures/moderation_seed_plan_reference.cjs --check /artifacts/moderation-seed-retirement/attempt1/seed-reference
