#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
NODE=/usr/local/bin/node
PIN=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
hash() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
[ "$(hash "$NODE")" = "$PIN" ]
export DIMA_ADVANCED_SOURCE_ROOT=/source/dimabot
export DIMA_ADVANCED_RE2_FIXTURE_ROOT=/artifacts/moderation-advanced/re2-node24/re2
export DIMA_ADVANCED_RE2_FIXTURE_BINARY_SHA256=94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb
export DIMA_ADVANCED_RE2_FIXTURE_MANIFEST_SHA256=e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664
export DIMA_ADVANCED_RE2_FIXTURE_PROVENANCE_SHA256=4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c
export DIMA_SPAM_LOADER_SHA256="$(hash tests/fixtures/moderation_spam_source.cjs)"
export DIMA_SPAM_READER_SHA256="$(hash tests/fixtures/moderation_spam_reference.cjs)"
export DIMA_SPAM_BENCH_READER_SHA256="$(hash tests/fixtures/moderation_spam_benchmark.cjs)"
export DIMA_SEMANTIC_LOADER_SHA256="$(hash tests/fixtures/moderation_semantic_source.cjs)"
export DIMA_SEMANTIC_READER_SHA256="$(hash tests/fixtures/moderation_semantic_reference.cjs)"
export DIMA_SEMANTIC_WORKER_READER_SHA256="$(hash tests/fixtures/moderation_semantic_worker_reference.cjs)"
export DIMA_VARIATIONS_BENCH_LOADER_SHA256="$(hash tests/fixtures/moderation_variations_source.cjs)"
export DIMA_VARIATIONS_READER_SHA256="$(hash tests/fixtures/moderation_variations_reference.cjs)"
export DIMA_VARIATIONS_BENCH_READER_SHA256="$(hash tests/fixtures/moderation_variations_benchmark.cjs)"
export DIMA_VARIATION_JOBS_READER_SHA256="$(hash tests/fixtures/moderation_variation_jobs_reference.cjs)"
export DIMA_DECISIONS_LOADER_SHA256="$(hash tests/fixtures/moderation_decisions_source.cjs)"
export DIMA_DECISIONS_READER_SHA256="$(hash tests/fixtures/moderation_decisions_reference.cjs)"
for prefix in DIMA_MODERATION_NORMALIZE DIMA_LINKS DIMA_SPAM_CATEGORIES DIMA_SEED_PLAN DIMA_MODERATION_SCHEMA DIMA_SCHEMA DIMA_JS_UNICODE DIMA_MODERATION_TEXT DIMA_MODERATION_SCHEMA_BENCH; do
  export "${prefix}_SOURCE_ROOT=/source/dimabot" "${prefix}_NODE_SHA256=$PIN"
done
export DIMA_BLACKLIST_SOURCE_ROOT=/source/dimabot DIMA_RULE_SOURCE_ROOT=/source
base=/artifacts/moderation-leaf-retirement/attempt4
# Refuse an existing run, including partial runs; parent must choose a fresh attempt.
mkdir -p /artifacts/moderation-leaf-retirement
test -d "$base"
"$NODE" --test tests/fixtures/moderation_leaf_source_resolver.test.cjs
for name in moderation_normalize_reference moderation_links_reference moderation_spam_categories_reference moderation_blacklist_reference moderation_rule_dispatcher_reference moderation_seed_plan_reference channel_moderation_settings_reference moderation_decision_schema_reference schema_composite_defaults_reference js_unicode_reference js_unicode17_prepare moderation_advanced_reference re2_native_reference moderation_variations_reference moderation_variation_jobs_reference moderation_spam_reference moderation_semantic_reference moderation_semantic_worker_reference moderation_decisions_reference moderation_advanced_benchmark moderation_spam_benchmark moderation_variations_benchmark moderation_blacklist_benchmark; do
  dir="$base/$name"
  case "$name" in moderation_blacklist_reference) dir="/artifacts/moderation-leaf-retirement/attempt6/$name"; mkdir -p "$(dirname "$dir")"; mkdir "$dir"; "$NODE" "tests/fixtures/$name.cjs" --write "$dir";; moderation_rule_dispatcher_reference) dir="/artifacts/moderation-leaf-retirement/attempt5/$name";; esac
  test -d "$dir"
  "$NODE" "tests/fixtures/$name.cjs" --check "$dir"
done
cmp "$base/js_unicode17_prepare/js_unicode_data.rs" src/utils/js_unicode_data.rs
export DIMA_MODERATION_TEXT_BENCH_DIR="$base/moderation_text_benchmark"
export DIMA_MODERATION_SCHEMA_BENCH_DIR="$base/channel_moderation_settings_benchmark"
test -d "$DIMA_MODERATION_TEXT_BENCH_DIR"; test -d "$DIMA_MODERATION_SCHEMA_BENCH_DIR"
for mode in --check; do
 "$NODE" tests/fixtures/moderation_text_benchmark.cjs "$mode"
 "$NODE" tests/fixtures/channel_moderation_settings_benchmark.cjs "$mode"
done
