set -eux
export TZ=UTC
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/schema_source_resolver.test.cjs
base=/artifacts/chatter-retirement/attempt1
mkdir -p "$base/chatter"
node tests/fixtures/moderation_chatter_schema_reference.cjs --write "$base/chatter"
node tests/fixtures/moderation_chatter_schema_reference.cjs --check "$base/chatter"
mkdir -p "$base/application"
node tests/fixtures/application_schemas_reference.mjs --write "$base/application"
node tests/fixtures/application_schemas_reference.mjs --check "$base/application"
mkdir -p "$base/additional"
node tests/fixtures/additional_schemas_reference.mjs --write "$base/additional"
node tests/fixtures/additional_schemas_reference.mjs --check "$base/additional"
mkdir -p "$base/named"
node tests/fixtures/schema_named_types_reference.cjs --write "$base/named"
node tests/fixtures/schema_named_types_reference.cjs --check "$base/named"
mkdir -p "$base/timer"
node tests/fixtures/timer_chat_schema_types_reference.cjs --write "$base/timer"
node tests/fixtures/timer_chat_schema_types_reference.cjs --check "$base/timer"
mkdir -p "$base/action"
node tests/fixtures/moderation_action_log_schema_reference.cjs --write "$base/action"
node tests/fixtures/moderation_action_log_schema_reference.cjs --check "$base/action"
mkdir -p "$base/fish"
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --write "$base/fish"
node tests/fixtures/channel_fish_voice_favorites_reference.cjs --check "$base/fish"
export DIMA_ADVANCED_SOURCE_ROOT=/source/dimabot
export DIMA_ADVANCED_RE2_FIXTURE_ROOT=/artifacts/moderation-advanced/re2-node24/re2
export DIMA_ADVANCED_RE2_FIXTURE_BINARY_SHA256=94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb
export DIMA_ADVANCED_RE2_FIXTURE_MANIFEST_SHA256=e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664
export DIMA_ADVANCED_RE2_FIXTURE_PROVENANCE_SHA256=4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c
export DIMA_SPAM_LOADER_SHA256=b5cf1d8d5c0f7105e8042ce47dd323486ff000e5a7b4695716db76f010dc6558
export DIMA_SPAM_READER_SHA256=3cd07fee4740325e384792737a396ce4ad1b69a5988c338f8a0f6b37f6f3dfd5
export DIMA_SPAM_BENCH_READER_SHA256=ae4d6131c2e375ddc437ff12fdd34a563708bc3dd2b1c297e82369eb32e9d723
mkdir -p "$base/spam" "$base/spam-benchmark"
node tests/fixtures/moderation_spam_reference.cjs --write "$base/spam"
node tests/fixtures/moderation_spam_reference.cjs --check "$base/spam"
node tests/fixtures/moderation_spam_benchmark.cjs --write "$base/spam-benchmark"
node tests/fixtures/moderation_spam_benchmark.cjs --check "$base/spam-benchmark"
