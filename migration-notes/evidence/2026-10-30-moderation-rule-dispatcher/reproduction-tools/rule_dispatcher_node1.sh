set -eu
export DIMA_RULE_SOURCE_ROOT=/source
node tests/fixtures/moderation_rule_dispatcher_reference.cjs --write /artifacts/moderation-rule-dispatcher/attempt1/reference
node tests/fixtures/moderation_rule_dispatcher_reference.cjs --check /artifacts/moderation-rule-dispatcher/attempt1/reference
