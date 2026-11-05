#!/bin/sh
set -eu
node ops/checks/duel-widget-browser.mjs
node ops/checks/widgets-hub-browser.mjs
SAAS_PLAYWRIGHT_MODULE=/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs SAAS_AXE_MODULE=/tmp/saas-cooldown-browser/node_modules/@axe-core/playwright/dist/index.js node ops/checks/duel.mjs
