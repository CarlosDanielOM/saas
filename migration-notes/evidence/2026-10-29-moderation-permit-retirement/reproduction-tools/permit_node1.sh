set -eu
export DIMA_PERMIT_SOURCE_ROOT=/source/dimabot
export DIMA_PERMIT_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
/usr/local/bin/node tests/fixtures/moderation_permit_reference.cjs --write /artifacts/moderation-permit/attempt1/reference
/usr/local/bin/node tests/fixtures/moderation_permit_reference.cjs --check /artifacts/moderation-permit/attempt1/reference
