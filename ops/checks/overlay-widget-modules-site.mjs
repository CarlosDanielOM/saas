// saas-ops copies only this entrypoint; companions remain in the chosen checkout.
const directory = process.env.SAAS_OVERLAY_CHECK_DIR || '/root/saas/ops/checks';
await import(`${directory}/overlay-widget-modules-browser.mjs`);
await import(`${directory}/overlay-interactions-browser.mjs`);
await import(`${directory}/overlay-tts-text-browser.mjs`);
