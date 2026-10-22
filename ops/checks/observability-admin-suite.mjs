// Runs every admin System analytics browser check in one `saas-ops verify` (it accepts a single --check).
import { execFileSync } from 'node:child_process';
for (const check of ['/root/saas/ops/checks/observability-admin-browser.mjs', '/root/saas/ops/checks/observability-servers-browser.mjs'])
  console.log(execFileSync(process.execPath, [check], { encoding: 'utf8', env: process.env, timeout: 280000 }));
