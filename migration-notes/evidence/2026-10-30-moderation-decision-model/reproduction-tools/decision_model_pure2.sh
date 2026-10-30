set -eu
. /task-tools/decision_model_env2.sh
cargo test --locked --offline --no-default-features --features moderation-decision-schema --test moderation_decision_schema replay_actual_source -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features moderation-decision-schema --test mongoose_set_on_insert replay_sdk_fixture -- --ignored --exact --nocapture
