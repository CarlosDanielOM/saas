set -eu
wave=/artifacts/ai-usage-lock/attempt2/reference
mkdir -p "$wave"
node tests/fixtures/ai_usage_lock_reference.cjs --write "$wave"
node tests/fixtures/ai_usage_lock_reference.cjs --check "$wave"
