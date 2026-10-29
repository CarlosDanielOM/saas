set -eu
export DIMA_SEED_PLAN_SOURCE_ROOT=/source/dimabot
export DIMA_SEED_PLAN_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/moderation_seed_plan_reference.cjs --write /artifacts/moderation-seed-plan/attempt1/reference
node tests/fixtures/moderation_seed_plan_reference.cjs --check /artifacts/moderation-seed-plan/attempt1/reference
