// Runs the site checks for shared Bits rules in one saas-ops verify (the helper takes a single --check).
import { execFileSync } from 'node:child_process';
for (const check of ['bits-rules-browser.mjs', 'alert-design-tools-browser.mjs']) {
  execFileSync(process.execPath, [`/root/saas/ops/checks/${check}`], { stdio: 'inherit', env: process.env, timeout: 280000 });
}
console.log('PASS site: shared Bits rules (chat events + Overlay Studio) and alert design variants');
