// Runs the Goals page browser checks against one site candidate (saas-ops verify takes a single --check, 300 s):
// the Twitch goals section (twitch-goals-browser) and our own goals editor (goals-browser), in parallel.
// The Studio goal-source check lives in custom-widgets-browser.mjs (section 4e); it takes longer than the verify limit,
// so run it against the candidate's exact bundle (see ops/README "custom browser check") or a preview.
// Checks are referenced by absolute path because verify runs this file from a copy.
import { spawn } from 'node:child_process';
const dir = process.env.TWITCH_GOALS_CHECKS_DIR || '/root/saas/ops/checks';
const checks = ['twitch-goals-browser', 'goals-browser'];
const run = name => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, [`${dir}/${name}.mjs`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  child.on('close', code => resolve({ name, code, out, seconds: ((Date.now() - started) / 1000).toFixed(1) }));
});
const results = await Promise.all(checks.map(run));
let failed = false;
for (const r of results) {
  console.log(`${r.code === 0 ? 'PASS' : 'FAIL'} ${r.name} (${r.seconds}s)`);
  if (r.code !== 0) { failed = true; console.log(r.out.slice(-3000)); } else console.log(r.out.trim().split('\n').filter(line => line.startsWith('PASS')).map(line => '  ' + line).join('\n'));
}
if (failed) process.exit(1);
console.log('PASS Twitch goals site suite');
