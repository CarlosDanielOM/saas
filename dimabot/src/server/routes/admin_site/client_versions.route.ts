import express from 'express';
import { clientVersionReport } from '../../../overlays/client-versions.js';
import { connectedClientVersions } from '../../../overlays/live/index.js';
import { ownerGet } from './shared.js';

/**
 * Owner-only: which page versions are in use and which compatibility code (overlays/compat.ts) can be removed.
 * Mounted under `/admin-site` by `admin_site.route.ts`. Read-only; nothing is ever removed from here.
 */
const router = express.Router();

ownerGet(router, '/client-versions', () => clientVersionReport(Date.now(), connectedClientVersions()));

export const adminClientVersionsRouter = router;
