set -eux
cd /source/dimabot
export TZ=UTC
export RUST_BACKTRACE=1
export DIMA_SPAM_LOADER_SHA256=b5cf1d8d5c0f7105e8042ce47dd323486ff000e5a7b4695716db76f010dc6558
export DIMA_SPAM_READER_SHA256=3cd07fee4740325e384792737a396ce4ad1b69a5988c338f8a0f6b37f6f3dfd5
export DIMA_SEMANTIC_LOADER_SHA256=25b2c5491f482802a5d40833b4f9854617941669201bb9735bda108f44dd53be
export DIMA_SEMANTIC_READER_SHA256=8f968ed480ef07491cc0bf4174b365911d888e19074e0df4603ea1b3ebe00f4a
export DIMA_SEMANTIC_WORKER_READER_SHA256=b1eaab7a015af47e493464174a3dab2f7e72061b9d72c6debdeb285980eef740
export DIMA_DECISIONS_LOADER_SHA256=f3dc9a67a08ad06425dc5ee7eb167673552335ffe4acd68826423330fb1fdb9c
export DIMA_DECISIONS_READER_SHA256=0b7837d2b16d5e6fcdfffb687f0a2c7b2023289f2b7351dbb2faf1dcb1cf503b
export DIMA_OPENROUTER_ATTRIBUTION_REFERENCE=/artifacts/attribution/attempt1/attribution/openrouter-attribution-reference.json
export DIMA_OPENROUTER_ATTRIBUTION_REFERENCE_SHA256=8c075f6231f30963e4ddf06de1205a121e0e3d6f94e73b550521554682064e3c
export DIMA_VARIATION_JOBS_REFERENCE=/artifacts/attribution/attempt1/jobs/moderation-variation-jobs-reference.json
export DIMA_VARIATION_JOBS_REFERENCE_SHA256=faf65e37c9b05ee47e306077cae75762ee578105a05d3a908aabd2758c99d03d
export DIMA_VARIATIONS_REFERENCE=/artifacts/attribution/attempt1/variations/moderation-variations-reference.json
export DIMA_VARIATIONS_REFERENCE_SHA256=47276de61a7f52c75090356aa688b6401e625b0af4531e127201820c5031f37b
export DIMA_SEMANTIC_REFERENCE=/artifacts/attribution/attempt1/semantic/moderation-semantic-reference.json
export DIMA_SEMANTIC_REFERENCE_SHA256=4c4a77bb9b9e1f82be88b8eac638698cdaf3b97ce4dac98cb96030d13d57ef21
export DIMA_SEMANTIC_WORKER_REFERENCE=/artifacts/attribution/attempt1/worker/moderation-semantic-worker-reference.json
export DIMA_SEMANTIC_WORKER_REFERENCE_SHA256=ea24bb80204e79a0a0f1d4d22cb36582029adcd589e8306a8c8a61980c2056cb
export DIMA_DECISIONS_REFERENCE=/artifacts/attribution/attempt1/decisions/moderation-decisions-reference.json
export DIMA_DECISIONS_REFERENCE_SHA256=dd6c174de8fdea154db77fdc5bb835d5ea305ffcec9cea17e37f254ef036de56
export DIMA_VARIATION_JOBS_SOURCE_ROOT=/artifacts/attribution/attempt1/jobs-source-provenance
export DIMA_VARIATION_JOBS_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export DIMA_DECISIONS_SDK_SOURCE_ROOT=/artifacts/attribution/attempt1/decisions-source-provenance
export FISH_TTS_FIXTURE_DIR=/artifacts/attribution/attempt1/fish
export PIPER_KOKORO_FIXTURE_DIR=/artifacts/attribution/attempt1/piper-kokoro
export TTS_RUNTIME_FIXTURE_DIR=/artifacts/attribution/attempt1/runtime
cargo fmt --all -- --check
features=moderation-variation-jobs,moderation-semantic-worker,moderation-decisions
cargo test --locked --offline --no-default-features --features "$features" --test openrouter_attribution --test moderation_variations --test moderation_variations_provider --test moderation_semantic --test moderation_semantic_provider --test moderation_decisions
timeout 300 cargo test --locked --offline --no-default-features --features "$features" --test openrouter_attribution archived_source_constant_matches_the_native_constant -- --ignored --exact --nocapture --test-threads=1
timeout 300 cargo test --locked --offline --no-default-features --features "$features" --test moderation_variations external_source_fixture_replays_native_value_calls -- --ignored --exact --nocapture --test-threads=1
timeout 300 cargo test --locked --offline --no-default-features --features "$features" --test moderation_semantic_source all_pure_source_records -- --ignored --exact --nocapture --test-threads=1
timeout 300 cargo test --locked --offline --no-default-features --features "$features" --test moderation_semantic_source every_evaluate_record_through_concrete_provider -- --ignored --exact --nocapture --test-threads=1
timeout 300 cargo test --locked --offline --no-default-features --features "$features" --test moderation_semantic_worker audit_every_source_record -- --ignored --exact --nocapture --test-threads=1
timeout 300 cargo test --locked --offline --no-default-features --features "$features" --test moderation_decisions source_reference_hash_and_pre_cast_creation_replay -- --ignored --exact --nocapture --test-threads=1
timeout 300 cargo test --locked --offline --no-default-features --features "$features" --test moderation_decisions source_mongoose_query_probe_compares_cast_insert_wire_shape -- --ignored --exact --nocapture --test-threads=1
timeout 300 cargo test --locked --offline --no-default-features --features "$features" --test moderation_variation_jobs_source all_38_actual_source_cases_with_native_private_services -- --ignored --exact --nocapture --test-threads=1
features=tts-services
timeout 180 cargo test --locked --offline --no-default-features --features "$features" --test tts_providers typescript_service_fixture_replay -- --ignored --exact --nocapture --test-threads=1
timeout 180 cargo test --locked --offline --no-default-features --features "$features" --test piper_tts replay_piper_source_fixture -- --ignored --exact --nocapture --test-threads=1
timeout 180 cargo test --locked --offline --no-default-features --features "$features" --test kokoro_tts replay_kokoro_source_fixture -- --ignored --exact --nocapture --test-threads=1
timeout 180 cargo test --locked --offline --no-default-features --features "$features" --test tts_runtime source_config_fixture -- --ignored --exact --nocapture --test-threads=1
timeout 180 cargo test --locked --offline --no-default-features --features "$features" --test tts_runtime dynamic_source_replay -- --ignored --exact --nocapture --test-threads=1
cargo clippy --locked --offline --no-default-features --features moderation-variation-jobs,moderation-semantic-worker,moderation-decisions,tts-services --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
