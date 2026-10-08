// The helper copies this check before execution. Resolve companion checks from
// the checkout, or an explicitly selected isolated source tree.
const directory = process.env.SAAS_OVERLAY_CHECK_DIR || '/root/saas/ops/checks';
await import(`${directory}/overlay-interactions-browser.mjs`);
await import(`${directory}/overlay-tts-text-browser.mjs`);
