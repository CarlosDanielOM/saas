import express from 'express';
import { ownerGet } from './shared.js';
import { parseUsageFilters, parseUsageTransactionQuery, usageSummary, usageTransactions } from '../../services/admin_usage.service.js';

/** Owner-only admin site routes, mounted under `/admin-site` by `admin_site.route.ts`. Register with `ownerGet`/`ownerPut` from `./shared.js`. */
const router = express.Router();

ownerGet(router, '/usage/summary', req => usageSummary(parseUsageFilters(req.query)));
ownerGet(router, '/usage/transactions', req => usageTransactions(parseUsageTransactionQuery(req.query)));

export const adminUsageRouter = router;
