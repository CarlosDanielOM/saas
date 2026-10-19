// Runs every stream timeline browser check in one `saas-ops verify` (it accepts a single --check).
import { spawnSync } from 'node:child_process';
const dir = process.env.SAAS_TIMELINE_CHECKS || '/root/saas/ops/checks';
for (const name of ['stream-timeline-site.mjs', 'stream-timeline-expanded-site.mjs', 'stream-timeline-ux-site.mjs']) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [`${dir}/${name}`], { stdio: 'inherit', env: process.env });
  if (run.status !== 0) { console.error(`FAIL ${name} (exit ${run.status})`); process.exit(run.status || 1); }
  console.log(`ok ${name} in ${Math.round((Date.now() - started) / 1000)}s`);
}
console.log('PASS STREAM TIMELINE SITE SUITE');
