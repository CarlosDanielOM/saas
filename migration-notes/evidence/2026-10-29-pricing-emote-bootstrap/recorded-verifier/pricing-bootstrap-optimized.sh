export DIMA_JS_ROUND_FIXTURE_DIR=/artifacts/pricing-emote-bootstrap/rounding
cargo test --locked --offline --no-default-features --features credit-policy --lib matches_node_math_round_raw_bits -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features tts-utilities --lib matches_node_math_round_raw_bits -- --ignored --nocapture
sh -eu /task-tools/pricing-bootstrap.sh
