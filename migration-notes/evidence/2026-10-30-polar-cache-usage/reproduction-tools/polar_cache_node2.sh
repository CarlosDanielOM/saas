set -eu
export KEYWORD_FIXTURE_NAMESPACE=keyword-fixture-fca01b6f57a8:
mkdir -p /artifacts/polar-cache-usage/attempt2/reference
node --check tests/fixtures/polar_cache_usage_reference.cjs
node tests/fixtures/polar_cache_usage_reference.cjs --write /artifacts/polar-cache-usage/attempt2/reference
node tests/fixtures/polar_cache_usage_reference.cjs --check /artifacts/polar-cache-usage/attempt2/reference
sha256sum /artifacts/polar-cache-usage/attempt2/reference/polar-cache-usage.json
