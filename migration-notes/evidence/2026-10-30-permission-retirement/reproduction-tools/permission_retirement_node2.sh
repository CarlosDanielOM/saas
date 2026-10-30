set -eu
export PERMISSION_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
mkdir -p /artifacts/permission-retirement/attempt2/reference
node tests/fixtures/permission_error_rate_limit_reference.cjs --write /artifacts/permission-retirement/attempt2/reference
node tests/fixtures/permission_error_rate_limit_reference.cjs --check /artifacts/permission-retirement/attempt2/reference
