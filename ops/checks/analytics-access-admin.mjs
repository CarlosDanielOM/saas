// The helper copies this entrypoint into its receipt directory; child checks
// resolve from the invoking repository root and inherit the candidate URL.
import { execFileSync } from 'node:child_process';
for (const check of ['analytics-access-browser.mjs', 'observability-admin-browser.mjs']) {
  execFileSync(process.execPath, [`ops/checks/${check}`], { stdio: 'inherit' });
}
