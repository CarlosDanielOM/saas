set -eu
export DIMA_RE2_CODEC_PROBE_BINARY=/artifacts/moderation-advanced/codec-probe/re2_codec_probe.node
export DIMA_RE2_CODEC_PROBE_SHA256=4270949a101973cea8bd4768ce26c738e95d7c94c26bb2da0cee29befb8f0846
export DIMA_RE2_CODEC_RE2_ROOT=/artifacts/moderation-advanced/re2-node24/re2
export DIMA_RE2_CODEC_RE2_SHA256=94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb
node /task-tools/re2_codec_probe.cjs --write /artifacts/moderation-advanced/codec-probe/reference
node /task-tools/re2_codec_probe.cjs --check /artifacts/moderation-advanced/codec-probe/reference
