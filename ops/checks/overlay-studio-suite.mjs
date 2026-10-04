// Runs the Overlay Studio checks. For saas-ops' five-minute check limit,
// verify the same candidate with overlay-studio-{motion,editor,reliability}-suite.mjs in sequence.
// Checks are referenced by absolute path because verify runs this file from a copy.
import { spawnSync } from 'node:child_process';
const dir = process.env.SAAS_OVERLAY_CHECK_DIR || '/root/saas/ops/checks';
const checks = [
  'alert-keyframes-browser.mjs', 'alert-keyframes-runtime-browser.mjs',
  'alert-design-tools-browser.mjs', 'alert-design-runtime-browser.mjs', 'alert-timeline-browser.mjs', 'alert-sound-browser.mjs', 'alert-object-motion-browser.mjs',
  'overlay-studio-redesign-browser.mjs', 'overlay-studio-browser.mjs', 'overlay-history-browser.mjs',
  'overlay-trigger-filters-browser.mjs', 'overlay-connections-browser.mjs', 'overlay-controls-browser.mjs',
  'overlay-free-browser.mjs', 'overlay-alert-rendering-browser.mjs', 'overlay-draft-protection.mjs',
  'overlay-reliability-browser.mjs', 'overlay-refresh-browser.mjs', 'overlay-recovery-browser.mjs',
  'asset-library-browser.mjs', 'overlay-stacking-browser.mjs'
];
const batch = process.env.SAAS_OVERLAY_BATCH || 'all';
const selected = batch === 'all' ? checks : batch === 'motion' ? checks.slice(0,7) : batch === 'editor' ? checks.slice(7,14) : batch === 'reliability' ? checks.slice(14) : null;
if (!selected) throw new Error('Unknown Overlay Studio check batch: ' + batch);
let failed = 0;
for (const check of selected) {
  const run = spawnSync(process.execPath, [`${dir}/${check}`], { stdio: 'inherit', timeout: 900000, env: { ...process.env, SAAS_FIXTURE_PORT: process.env.SAAS_FIXTURE_PORT || '4293' } });
  if (run.status !== 0) { failed++; console.log(`FAIL ${check} (exit ${run.status ?? run.signal})`); }
}
if (failed) { console.log(`${failed} of ${selected.length} Overlay Studio checks failed`); process.exit(1); }
console.log(`PASS all ${selected.length} Overlay Studio checks`);
