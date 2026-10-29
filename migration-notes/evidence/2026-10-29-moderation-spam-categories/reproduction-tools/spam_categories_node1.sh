set -eu
export DIMA_SPAM_CATEGORIES_SOURCE_ROOT=/source/dimabot
export DIMA_SPAM_CATEGORIES_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
/usr/local/bin/node tests/fixtures/moderation_spam_categories_reference.cjs --write /artifacts/moderation-spam-categories/attempt1/reference
/usr/local/bin/node tests/fixtures/moderation_spam_categories_reference.cjs --check /artifacts/moderation-spam-categories/attempt1/reference
