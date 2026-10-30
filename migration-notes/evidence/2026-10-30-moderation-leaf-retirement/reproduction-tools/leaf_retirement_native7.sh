#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/moderation-leaf-retirement/attempt4
hash() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
export DIMA_MODERATION_NORMALIZE_FIXTURE_DIR="$base/moderation_normalize_reference"
export DIMA_MODERATION_NORMALIZE_FIXTURE_SHA256="$(hash "$DIMA_MODERATION_NORMALIZE_FIXTURE_DIR/moderation-normalize-reference.json")"
export DIMA_LINKS_REFERENCE_DIR="$base/moderation_links_reference"
export DIMA_SPAM_CATEGORIES_REFERENCE="$base/moderation_spam_categories_reference/moderation_spam_categories_reference.json"
export DIMA_MODERATION_BLACKLIST_FIXTURE_DIR="/artifacts/moderation-leaf-retirement/attempt6/moderation_blacklist_reference"
export DIMA_MODERATION_BLACKLIST_FIXTURE_SHA256="$(hash "$DIMA_MODERATION_BLACKLIST_FIXTURE_DIR/moderation-blacklist-reference.json")"
export DIMA_RULE_DISPATCHER_FIXTURE_DIR="/artifacts/moderation-leaf-retirement/attempt5/moderation_rule_dispatcher_reference"
export DIMA_RULE_DISPATCHER_FIXTURE_SHA256="$(hash "$DIMA_RULE_DISPATCHER_FIXTURE_DIR/moderation-rule-dispatcher-reference.json")"
export DIMA_SEED_PLAN_FIXTURE_DIR="$base/moderation_seed_plan_reference"
export DIMA_SEED_PLAN_FIXTURE_SHA256="$(hash "$DIMA_SEED_PLAN_FIXTURE_DIR/moderation-seed-plan-reference.json")"
export DIMA_MODERATION_SCHEMA_REFERENCE_DIR="$base/channel_moderation_settings_reference"
export DIMA_MODERATION_SCHEMA_REFERENCE_SHA256="$(hash "$DIMA_MODERATION_SCHEMA_REFERENCE_DIR/channel-moderation-settings-reference.json")"
export DIMA_DECISION_SCHEMA_FIXTURE_DIR="$base/moderation_decision_schema_reference"
export DIMA_DECISION_SCHEMA_FIXTURE_SHA256="$(hash "$DIMA_DECISION_SCHEMA_FIXTURE_DIR/moderation-decision-schema-reference.json")"
export DIMA_SCHEMA_COMPOSITE_FIXTURE_DIR="$base/schema_composite_defaults_reference"
export DIMA_SCHEMA_COMPOSITE_FIXTURE_SHA256="$(hash "$DIMA_SCHEMA_COMPOSITE_FIXTURE_DIR/schema-composite-defaults-reference.json")"
export DIMA_JS_UNICODE_DATA_DIR="$base/js_unicode17_prepare" DIMA_JS_UNICODE_SOURCE_DIR="$base/js_unicode_reference"
export DIMA_JS_UNICODE_DATA_SHA256="$(hash "$DIMA_JS_UNICODE_DATA_DIR/unicode17-reference.json")"
export DIMA_JS_UNICODE_SOURCE_SHA256="$(hash "$DIMA_JS_UNICODE_SOURCE_DIR/js-unicode-source-reference.json")"
features=moderation-rules,moderation-seed-plan,moderation-decision-schema
cargo test --locked --offline --no-default-features --features "$features" --test js_unicode --test moderation_normalize --test moderation_links --test moderation_spam_categories --test moderation_blacklist --test moderation_rule_dispatcher --test moderation_seed_plan --test channel_moderation_settings_schema --test moderation_decision_schema --test schema_composite_defaults --test moderation_text_benchmark --test channel_moderation_settings_benchmark
for spec in 'js_unicode replay_node_unicode17_and_actual_source' 'moderation_normalize replay_actual_normalize_exports' 'moderation_links replay_actual_source' 'moderation_spam_categories replay_reference_full_wire' 'moderation_blacklist replay_actual_blacklist_exports' 'moderation_rule_dispatcher replay_actual_dispatcher' 'moderation_seed_plan replay_actual_seed_plan' 'channel_moderation_settings_schema replay_actual_mongoose_schema' 'moderation_decision_schema replay_actual_source' 'schema_composite_defaults replay_mongoose_composite_defaults'; do
 set -- $spec
 cargo test --locked --offline --no-default-features --features "$features" --test "$1" "$2" -- --ignored --exact --nocapture
done
export MODERATION_ADVANCED_FIXTURE="$base/moderation_advanced_reference/moderation-advanced-reference.json"
export MODERATION_ADVANCED_FIXTURE_SHA256="$(hash "$MODERATION_ADVANCED_FIXTURE")"
export DIMA_VARIATIONS_REFERENCE="$base/moderation_variations_reference/moderation-variations-reference.json"
export DIMA_VARIATIONS_REFERENCE_SHA256="$(hash "$DIMA_VARIATIONS_REFERENCE")"
export DIMA_SPAM_REFERENCE="$base/moderation_spam_reference/moderation-spam-reference.json"
export DIMA_SPAM_REFERENCE_SHA256="$(hash "$DIMA_SPAM_REFERENCE")"
export DIMA_SEMANTIC_REFERENCE="$base/moderation_semantic_reference/moderation-semantic-reference.json"
export DIMA_SEMANTIC_REFERENCE_SHA256="$(hash "$DIMA_SEMANTIC_REFERENCE")"
export DIMA_SEMANTIC_WORKER_REFERENCE="$base/moderation_semantic_worker_reference/moderation-semantic-worker-reference.json"
export DIMA_SEMANTIC_WORKER_REFERENCE_SHA256="$(hash "$DIMA_SEMANTIC_WORKER_REFERENCE")"
export DIMA_DECISIONS_REFERENCE="$base/moderation_decisions_reference/moderation-decisions-reference.json"
export DIMA_DECISIONS_REFERENCE_SHA256="$(hash "$DIMA_DECISIONS_REFERENCE")"
export DIMA_SPAM_LOADER_SHA256="$(hash tests/fixtures/moderation_spam_source.cjs)" DIMA_SPAM_READER_SHA256="$(hash tests/fixtures/moderation_spam_reference.cjs)"
export DIMA_SEMANTIC_LOADER_SHA256="$(hash tests/fixtures/moderation_semantic_source.cjs)" DIMA_SEMANTIC_READER_SHA256="$(hash tests/fixtures/moderation_semantic_reference.cjs)"
export DIMA_RE2_SYNTAX_REFERENCE=$base/re2_native_reference/re2-native-syntax.json
export DIMA_RE2_SYNTAX_REFERENCE_SHA256="$(hash "$DIMA_RE2_SYNTAX_REFERENCE")"
# SDK source capture must be supplied by the operator; never substitute unverified sources.
: "${DIMA_DECISIONS_SDK_SOURCE_ROOT:?independently captured SDK provenance is required}"
features=moderation-advanced,moderation-variations,moderation-spam,moderation-semantic-worker,moderation-decisions
cargo test --locked --offline --no-default-features --features "$features" --test moderation_advanced --test moderation_variations --test moderation_spam --test moderation_spam_source --test moderation_semantic --test moderation_semantic_source --test moderation_semantic_worker --test moderation_decisions --test re2_native_syntax
for spec in 'moderation_advanced fixture::replay_all_464_source_cases' 'moderation_variations external_source_fixture_replays_native_value_calls' 'moderation_spam_source all_pure_source_records' 'moderation_semantic_source all_pure_source_records' 'moderation_semantic_worker audit_every_source_record' 'moderation_decisions source_reference_hash_and_pre_cast_creation_replay' 'moderation_decisions source_mongoose_query_probe_compares_cast_insert_wire_shape' 're2_native_syntax replay_native_syntax_oracle'; do
 set -- $spec
 cargo test --locked --offline --no-default-features --features "$features" --test "$1" "$2" -- --ignored --exact --nocapture
done

sh /task-tools/leaf_retirement_quality1.sh
