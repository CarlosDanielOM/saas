set -eu
export DIMA_JS_UNICODE_SOURCE_ROOT=/source/dimabot
export DIMA_JS_UNICODE_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
node /task-tools/js_unicode17_prepare.cjs --write /artifacts/js-unicode17/initial
node /task-tools/js_unicode17_prepare.cjs --check /artifacts/js-unicode17/initial
