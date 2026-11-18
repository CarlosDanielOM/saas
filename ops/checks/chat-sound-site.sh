#!/bin/sh
# Chat sound site release: the feature check, then the checks for what it touches (the shared OBS link component,
# the modules catalog and Spanish copy). Run from the checkout:
#   scripts/saas-ops verify site-RUN --check ops/checks/chat-sound-site.sh
# Before committing, point CHECKS at a worktree's ops/checks with a scratch copy of this file (verify runs a clean env).
set -eu
CHECKS=${CHECKS:-ops/checks}
node "$CHECKS/chat-sound-browser.mjs"
node "$CHECKS/overlay-links-web.mjs"
node "$CHECKS/modules-core-grouping.mjs"
node "$CHECKS/es-mx-translation-browser.mjs"
