set -eu
export DIMA_CAPS_SOURCE_ROOT=/source/dimabot
export DIMA_CAPS_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node /task-tools/moderation_caps_unicode_prepare.cjs --write /artifacts/moderation-caps/unicode-initial
node /task-tools/moderation_caps_unicode_prepare.cjs --check /artifacts/moderation-caps/unicode-initial
