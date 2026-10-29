set -eu
export PERMISSION_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/permission_error_rate_limit_reference.cjs --write /artifacts/permission-error-limiter/attempt1/reference
node tests/fixtures/permission_error_rate_limit_reference.cjs --check /artifacts/permission-error-limiter/attempt1/reference
