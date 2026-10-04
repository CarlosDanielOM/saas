// Runs every Overlay Studio browser check against one candidate (saas-ops verify takes a single --check).
// Checks are referenced by absolute path because verify runs this file from a copy.
import { spawnSync } from 'node:child_process';
const dir = process.env.SAAS_OVERLAY_CHECK_DIR || '/root/saas/ops/checks';
const checks = [
  'alert-design-tools-browser.mjs', 'alert-design-runtime-browser.mjs', 'alert-timeline-browser.mjs', 'alert-sound-browser.mjs', 'alert-object-motion-browser.mjs',
  'overlay-studio-redesign-browser.mjs', 'overlay-studio-browser.mjs', 'overlay-history-browser.mjs',
  'overlay-trigger-filters-browser.mjs', 'overlay-connections-browser.mjs', 'overlay-controls-browser.mjs',
  'overlay-free-browser.mjs', 'overlay-alert-rendering-browser.mjs', 'overlay-draft-protection.mjs',
  'overlay-reliability-browser.mjs', 'overlay-refresh-browser.mjs', 'overlay-recovery-browser.mjs',
  'asset-library-browser.mjs', 'overlay-stacking-browser.mjs'
];
let failed = 0;
for (const check of checks) {
  const run = spawnSync(process.execPath, [`${dir}/${check}`], { stdio: 'inherit', timeout: 900000, env: { ...process.env, SAAS_FIXTURE_PORT: process.env.SAAS_FIXTURE_PORT || '4293' } });
  if (run.status !== 0) { failed++; console.log(`FAIL ${check} (exit ${run.status ?? run.signal})`); }
}
if (failed) { console.log(`${failed} of ${checks.length} Overlay Studio checks failed`); process.exit(1); }
console.log(`PASS all ${checks.length} Overlay Studio checks`);
