#!/bin/sh
# Stand-in for ffmpeg in tests/thumbnails.rs and tests/record-thumbnails.mts; the real program is
# never run. It reads the input named after -i and the output (last argument), both possibly
# prefixed with `file:`, and acts on the input's first four bytes. Under the Rust tests its working
# directory is <base>/tmp/thumb-<hex>, and it records what it saw in <base>/rec when that exists;
# under the recorder it appends its arguments to $FAKE_FFMPEG_LOG.
in=""
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then in="$a"; fi
  prev="$a"
  out="$a"
done
in="${in#file:}"
out="${out#file:}"
if [ -n "$FAKE_FFMPEG_LOG" ]; then
  printf '%s\0' "$@" >> "$FAKE_FFMPEG_LOG"
  printf '\n' >> "$FAKE_FFMPEG_LOG"
fi
B="$(cd ../.. 2>/dev/null && pwd -P)"
R="$B/rec"
if [ -d "$R" ]; then
  printf '%s\0' "$@" > "$R/args"
  /usr/bin/cat /proc/$$/environ > "$R/env"
  pwd -P > "$R/cwd"
  echo $$ > "$R/pid"
  /usr/bin/cat "$in" > "$R/input"
fi
filler() { i=0; while [ $i -lt 40 ]; do printf 'ABCDEFGHIJ'; i=$((i+1)); done; }
kind="$(/usr/bin/head -c 4 "$in")"
case "$kind" in
  FAIL) echo "boom: invalid data found when processing input" >&2; exit 1 ;;
  TINY) printf 'tiny' > "$out" ;;
  NONE) : ;;
  NOTJ) filler > "$out" ;;
  HUGE) { printf '\377\330\377\340'; /usr/bin/head -c 3000000 /dev/zero; } > "$out" ;;
  HANG) : > "$R/started"; : > "$R/running.$$"; /usr/bin/sleep 1000 ;;
  FORK) /usr/bin/sleep 1000 & echo $! > "$R/child"; : > "$R/started"; /usr/bin/sleep 1000 ;;
  LOUD) /usr/bin/head -c 9000000 /dev/zero >&2 ;;
  *) { printf '\377\330\377\340'; filler; printf '\377\331'; } > "$out" ;;
esac
