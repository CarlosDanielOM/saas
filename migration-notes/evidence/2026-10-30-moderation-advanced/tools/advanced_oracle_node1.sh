set -eu
export DIMA_ADVANCED_SOURCE_ROOT=/source/dimabot
node tests/fixtures/moderation_advanced_reference.cjs --write /artifacts/moderation-advanced/attempt1/reference
node tests/fixtures/moderation_advanced_reference.cjs --check /artifacts/moderation-advanced/attempt1/reference
