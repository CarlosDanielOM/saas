import express from 'express';
import { adminOverview } from '../../services/admin_overview.service.js';
import { ownerGet } from './shared.js';

/** Owner-only admin site routes, mounted under `/admin-site` by `admin_site.route.ts`. */
const router = express.Router();

/** Everything across all channels at a glance; see `admin_overview.service.ts`. */
ownerGet(router, '/overview', () => adminOverview.get());

export const adminOverviewRouter = router;
