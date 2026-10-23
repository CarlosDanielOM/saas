import { pathToFileURL } from 'node:url';

// Sequential browsers: all API, Socket.IO and media data are mocked locally.
// saas-ops copies this entry alone into its private run directory.
for (const check of ['settings', 'follow', 'studio']) {
  await import(pathToFileURL(`/root/saas/ops/checks/dima032-site-${check}.mjs`).href);
}
