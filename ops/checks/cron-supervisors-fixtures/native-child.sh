#!/bin/sh
# Installed only over two unselected binaries inside a disposable candidate.
# No Node executable participates in the standalone exporter fixture.
case "$0" in
  */roulette_completion) prefix=roulette_completion ;;
  */raid_sessions) prefix=raid_sessions ;;
  *) exit 91 ;;
esac
[ "$(id -u)" = 65534 ] && [ "$(id -g)" = 65534 ] || exit 92
[ "${NODE_OPTIONS+x}" != x ] && [ "${SECRET_KEY+x}" != x ] && [ "${CLIENT_SECRET+x}" != x ] && [ "${UNRELATED_FIXTURE_SECRET+x}" != x ] || exit 93
case "${MONGO_URI:-}" in mongodb://mongo:27017/cron_supervisors_fixture_*) ;; *) exit 94 ;; esac
case "$*" in '--telemetry-json'|'--telemetry-json --once') ;; *) exit 95 ;; esac
printf '%s\n' 'PRIVATE_RAW_STDOUT'
printf '%s:{"event":"batch","events":1,"durationMs":1,"success":true,"secret":"PRIVATE_FRAME"}\n' "$prefix"
printf '%s:{"event":"batch","events":9999,"durationMs":1,"success":true}\n' "$prefix"
printf '%s:{"event":"batch","events":1,"durationMs":1,"success":false}\n' "$prefix"
printf '%s:{"event":"health","success":true,"secret":"PRIVATE_HEALTH"}\n' "$prefix"
# Oversized lines must not leak and must recover at the following newline.
i=0
while [ "$i" -lt 200 ]; do printf '%s' 'PRIVATE_OVERSIZED'; i=$((i + 1)); done
printf '\n'
printf '%s:{"event":"batch","events":3,"durationMs":2,"success":true}\n' "$prefix"
case "$*" in *--once*)
  if [ "$prefix" = roulette_completion ] && [ -f /tmp/saas-fixtures/fail-roulette-once ]; then exit 7; fi
  exit 0 ;;
esac
trap 'if [ -f /tmp/saas-fixtures/flood-supervisor-output ]; then printf "%s" "$$" > /tmp/saas-fixtures/flood-stopped; fi; exit 0' TERM INT
if [ "$prefix" = roulette_completion ] && [ -f /tmp/saas-fixtures/flood-supervisor-output ]; then
  i=0
  while [ "$i" -lt 20000 ]; do
    printf '%s:{"event":"batch","events":0,"durationMs":0,"success":true}\n' "$prefix"
    i=$((i + 1))
    if [ $((i % 256)) -eq 0 ]; then printf '%s' "$i" > /tmp/saas-fixtures/flood-progress; fi
  done
  printf '%s' "$i" > /tmp/saas-fixtures/flood-progress
fi
while :; do sleep 1; done
