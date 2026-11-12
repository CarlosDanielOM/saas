#!/bin/sh
# dima-rig: stands in for /usr/local/bin/cron_index, the native Rust index the cron host
# supervises. The reference image dimabot-ref:0c71108e is built without the native binaries
# (dimabot/dockerfile installs them only when .saas-native exists), and the cron host shuts
# itself down when the native index cannot start. The seven native workers' reference is the
# Rust in dima-rust/src at 0c71108e, verified on its own; this stub only keeps the slot.
trap 'exit 0' TERM INT
while :; do
    sleep 3600 &
    wait $!
done
