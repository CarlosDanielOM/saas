#!/bin/sh
# Duel widget regression check plus the overlay quality tiers (dashboard picker, OBS overlay per tier).
set -eu
node ops/checks/duel-widget-browser.mjs
node ops/checks/duel-quality-browser.mjs
