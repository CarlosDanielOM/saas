set -eu
export DIMA_REDIS_RUNTIME_SOURCE_ROOT=/source/dimabot
export DIMA_REDIS_RUNTIME_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_REDIS_RUNTIME_NATIVE_INPUTS='["src/utils/redis_application_runtime.rs","src/utils/databases/dragonfly.database.rs","src/utils/observability/mod.rs","src/utils/moderation/permit.rs","src/utils/moderation/offenses.rs","tests/redis_application_runtime.rs","tests/ai_credit_projection_support/mod.rs"]'
node tests/fixtures/redis_application_runtime_reference.cjs --write /artifacts/redis-application-runtime/attempt1/runtime-reference
node tests/fixtures/redis_application_runtime_reference.cjs --check /artifacts/redis-application-runtime/attempt1/runtime-reference
export DIMA_PERMIT_SOURCE_ROOT=/source/dimabot
export DIMA_PERMIT_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/moderation_permit_reference.cjs --write /artifacts/redis-application-runtime/attempt1/permit-reference
node tests/fixtures/moderation_permit_reference.cjs --check /artifacts/redis-application-runtime/attempt1/permit-reference
export DIMA_OFFENSE_SOURCE_ROOT=/source/dimabot
export DIMA_OFFENSE_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node tests/fixtures/moderation_offenses_reference.cjs --write /artifacts/redis-application-runtime/attempt1/offenses-reference
node tests/fixtures/moderation_offenses_reference.cjs --check /artifacts/redis-application-runtime/attempt1/offenses-reference
