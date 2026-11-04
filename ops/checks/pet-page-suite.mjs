// Runs every pet module page browser check against one candidate (saas-ops verify takes a single --check).
// Checks are referenced by absolute path because verify runs this file from a copy.
import { spawn } from 'node:child_process';
const dir = process.env.PET_CHECKS_DIR || '/root/saas/ops/checks';
const checks = ['pet-page-ux-browser', 'pet-configuration-browser', 'dima032-site-settings', 'pet-moods-browser', 'pet-fish-favorites-browser', 'pet-privacy-browser'];
const run = name => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, [`${dir}/${name}.mjs`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  child.on('close', code => resolve({ name, code, out, seconds: ((Date.now() - started) / 1000).toFixed(1) }));
});
// Three at a time keeps the run well under the verify time limit without starving the browser.
const results = [];
for (let i = 0; i < checks.length; i += 3) results.push(...await Promise.all(checks.slice(i, i + 3).map(run)));
let failed = false;
for (const r of results) {
  console.log(`${r.code === 0 ? 'PASS' : 'FAIL'} ${r.name} (${r.seconds}s)`);
  if (r.code !== 0) { failed = true; console.log(r.out.slice(-3000)); } else console.log('  ' + r.out.trim().split('\n').at(-1));
}
if (failed) process.exit(1);
console.log('PASS pet page suite');
