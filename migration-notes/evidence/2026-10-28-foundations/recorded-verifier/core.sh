set -eu
FEATURES=ast-blocks,ast-pure-functions,credit-policy,eventsub,chat-message,reward-body,domain-events,credential-crypto,jwt
cargo check --locked --offline --all-targets --no-default-features --features "$FEATURES"
cargo clippy --locked --offline --all-targets --no-default-features --features "$FEATURES" -- -D warnings
cargo test --locked --offline --no-default-features --features "$FEATURES"
AST_EXPORTS_BENCHMARK_OUTPUT=/artifacts/ast-exports-rust-optimized.json cargo test --locked --offline --release --no-default-features --features "$FEATURES" --test ast_blocks_exports benchmark_ast_block_exports -- --ignored --nocapture
CREDENTIAL_ACTIVATION_BENCHMARK_OUTPUT=/artifacts/credential-activation-rust.json cargo test --locked --offline --release --no-default-features --features "$FEATURES" --test credential_activation benchmark_credentials_and_activation -- --ignored --nocapture
DOMAIN_CONTRACT_BENCH_ITERATIONS=1000 cargo test --locked --offline --release --no-default-features --features "$FEATURES" --test domain_contracts domain_contracts_prepared_benchmark -- --ignored --nocapture
PURE_UTILS_ITERATIONS=100 PURE_UTILS_SAMPLES=7 cargo run --locked --offline --release --no-default-features --features "$FEATURES" --example pure_utils_benchmark > /artifacts/pure-utils-rust-optimized.json
