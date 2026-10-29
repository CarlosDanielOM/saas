set -eu
export DIMA_OFFENSE_SOURCE_ROOT=/source/dimabot
export DIMA_OFFENSE_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/moderation_offenses_reference.cjs --write /artifacts/moderation-offenses/attempt1/reference
node tests/fixtures/moderation_offenses_reference.cjs --check /artifacts/moderation-offenses/attempt1/reference
