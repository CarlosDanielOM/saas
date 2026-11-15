// Bounded batch for the same saas-ops candidate; run all six Overlay Studio batches.
process.env.SAAS_OVERLAY_BATCH = 'looks';
await import((process.env.SAAS_OVERLAY_CHECK_DIR || '/root/saas/ops/checks') + '/overlay-studio-suite.mjs');
