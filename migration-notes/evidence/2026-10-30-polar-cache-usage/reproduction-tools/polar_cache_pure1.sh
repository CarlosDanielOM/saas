set -eu
export POLAR_CACHE_USAGE_FIXTURE=/artifacts/polar-cache-usage/attempt1/reference/polar-cache-usage.json
export POLAR_CACHE_USAGE_FIXTURE_SHA256=c54a4e0a61f9dc04b1230e932ca37f95ee50afcec2c1d14db0ac860e6eb501b1
cargo test --locked --offline --no-default-features --features polar-cache-usage --test polar_cache_usage replay_every_generated_case -- --ignored --exact --nocapture
cargo clippy --locked --offline --no-default-features --features polar-cache-usage --test polar_cache_usage -- -D warnings
