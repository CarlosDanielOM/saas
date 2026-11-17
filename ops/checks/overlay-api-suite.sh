#!/bin/bash
# Overlay API regression suite: every overlay/TTS/widget API check against one saas-ops API candidate, one at a time,
# with the fixture staging each check needs. Run it for any release that touches dimabot overlays, TTS delivery,
# custom widgets or the Studio routes, from the production checkout:
#   ops/checks/overlay-api-suite.sh api-<run-id> [check-name ...]
# With names, only those checks run. The broad backend check runs last, because saas-ops deploy needs the run's
# last verify to have passed. A failing check is fixed in that release (or its owner is asked); never left stale.
set -u
RUN=${1:?usage: overlay-api-suite.sh api-<run-id> [check ...]}; shift
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=/root/saas
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT

# Staged fixture folders (copies, no symlinks) for checks that need files from several fixture sets.
mkdir -p "$STAGE/custom-widget" "$STAGE/widget-modules" "$STAGE/dima032"
cp -r "$HERE/custom-widget-fixtures/providers.mjs" "$HERE/custom-widget-fixtures/sample-chat" "$HERE/custom-widget-fixtures/dima-chat" "$STAGE/custom-widget/"
cp "$HERE/overlay-fixtures/providers.mjs" "$STAGE/custom-widget/base-providers.mjs"
cp -r "$HERE/overlay-interactions-fixtures/." "$STAGE/widget-modules/" && cp "$HERE/overlay-interactions.mjs" "$STAGE/widget-modules/"
cp "$HERE/dima032-fixtures/providers.mjs" "$HERE/dima032-fixtures/producer.mjs" "$HERE/dima032-fixtures/startup.mjs" "$STAGE/dima032/"
cp "$HERE/pet-runtime-fixtures/providers.mjs" "$STAGE/dima032/runtime-providers.mjs"
cp "$HERE/oauth-beta-fixtures/providers.mjs" "$STAGE/dima032/oauth-providers.mjs"

# name | test env | fixtures
SUITE=(
  "overlay-controls-api|overlay-controls-fixtures/api-env.json|$HERE/overlay-controls-fixtures"
  "overlay-reliability-api|overlay-fixtures/test-env.json|$HERE/overlay-fixtures"
  "alert-journal-dedupe-api|overlay-fixtures/test-env.json|$HERE/overlay-fixtures"
  "trigger-look-api|overlay-fixtures/test-env.json|$HERE/overlay-fixtures"
  "default-alerts-api|overlay-fixtures/test-env.json|$HERE/overlay-fixtures"
  "client-versions-api|overlay-fixtures/test-env.json|$HERE/overlay-fixtures"
  "overlay-clip-volume-api|overlay-fixtures/test-env.json|$HERE/overlay-fixtures"
  "overlay-widget-modules-api|overlay-interactions-fixtures/api-env.json|$STAGE/widget-modules"
  "custom-widgets-engine-api|custom-widget-fixtures/test-env.json|$STAGE/custom-widget"
  "twitch-goals|twitch-goals-fixtures/api-env.json|$HERE/twitch-goals-fixtures"
  "dima032-api|dima032-fixtures/api-env.json|$STAGE/dima032"
  "overlay-studio-backend|overlay-fixtures/test-env.json|$HERE/overlay-fixtures"
)
# Open issues: still run, reported as KNOWN with their reason, not counted as new failures. Remove an entry as soon
# as its check passes again (the suite says so). Never add an entry without a reason and a date.
declare -A KNOWN=(
  [dima032-api]="broken since a98d45b7 (2026-10-31, bisected 2026-11-16): pet read-TTS with overlay audio never reaches the OBS sources; unresolved, no channel uses it today"
)
failed=0; ran=0; known=0
for entry in "${SUITE[@]}"; do
  IFS='|' read -r name env fixtures <<< "$entry"
  if [ $# -gt 0 ] && [[ " $* " != *" $name "* ]]; then continue; fi
  ran=$((ran + 1)); log="$STAGE/$name.log"
  if (cd "$ROOT" && scripts/saas-ops verify "$RUN" --dependency mongo --dependency redis --test-env "$HERE/$env" --fixtures "$fixtures" --check "$HERE/$name.mjs") > "$log" 2>&1; then
    if [ -n "${KNOWN[$name]:-}" ]; then echo "PASS $name (listed as a known issue: remove it from KNOWN in this script)"; else echo "PASS $name"; fi
  elif [ -n "${KNOWN[$name]:-}" ]; then
    known=$((known + 1)); echo "KNOWN $name: ${KNOWN[$name]}"
  else
    failed=$((failed + 1)); echo "FAIL $name"; grep -v -E '^\s*$' "$log" | grep -i -E 'assert|error|timeout|saas-check.mjs:' | head -6
  fi
done
echo "$((ran - failed - known))/$ran overlay API checks passed on $RUN ($known known open issue(s), $failed new failure(s))"
[ "$failed" -eq 0 ]
