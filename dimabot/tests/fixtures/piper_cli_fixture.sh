#!/bin/sh
# Disposable process fixture only: this never imports Piper or downloads voices.
set -eu
test "$1" = -m
test "$2" = piper
test "$3" = -m
test "$5" = -f
voice=$4
output=$6
printf '%s\000' "$@" > "$output.argv"
printf '%s' "$$" > "$output.pid"
case "$voice" in
  stderr)
    i=0
    while [ "$i" -lt 2000 ]; do
      printf '0123456789' >&2
      i=$((i + 1))
    done
    printf ' STDERR-END \n' >&2
    exit 7
    ;;
  exit-empty) exit 9 ;;
  missing) exit 0 ;;
  signal) kill -KILL "$$" ;;
  stubborn)
    trap '' TERM
    sleep 60 &
    printf '%s' "$!" > "$output.child"
    printf ready > "$output.ready"
    wait
    ;;
  cooperative)
    trap 'exit 0' TERM
    sleep 60 &
    printf '%s' "$!" > "$output.child"
    printf ready > "$output.ready"
    wait
    ;;
  descendant)
    sleep 60 &
    printf '%s' "$!" > "$output.child"
    printf 'RIFFfixtureWAVE' > "$output"
    ;;
  *) printf 'RIFFfixtureWAVE' > "$output" ;;
esac
