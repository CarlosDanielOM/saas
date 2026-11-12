// Records the frozen TypeScript's answers to the usage page's reads over the local production
// copy (`domdimabot`, read only: no index is built, no collection created, nothing written), for
// every channel and customer of `ai_usage_ledger_states`. The fixture keeps ids and numbers
// only: each answer is kept as the SHA-256 of its JSON text, with a few of its figures. Run from
// the dimabot checkout with the clock fixed:
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC OBSERVABILITY_DISABLED=true node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/billing/tests/usage_recorded/record-real.mts" \
//     "$REPO/dima-rust/crates/billing/tests/usage_recorded/real.json"
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const root = process.env.DIMABOT_DIR!, require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose');
const output = process.argv[2];
// Half an hour after the latest receipt of the copy.
const NOW = Date.UTC(2026, 10, 11, 18, 0, 0), RealDate = Date;
let now = NOW;
class FixedDate extends RealDate { constructor(...a: any[]) { super(...(a.length ? a : [now]) as [any]); return new RealDate(...(a.length ? a : [now]) as [any]); } static now() { return now; } static [Symbol.hasInstance](v: any) { return v instanceof RealDate; } }
const sha = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: 'domdimabot', autoCreate: false, autoIndex: false });
  const ledger = await import(`${root}/src/utils/ai_usage_ledger.ts`);
  const dashboard = await import(`${root}/src/utils/ai_usage_dashboard.ts`);
  const queries = await import(`${root}/src/utils/ai_usage_queries.ts`);
  const receipts = await import(`${root}/src/utils/ai_usage_receipts.ts`);
  const states = await mongoose.connection.db.collection('ai_usage_ledger_states').find({}, { projection: { channelID: 1, customerId: 1 } }).sort({ channelID: 1, customerId: 1 }).toArray();
  globalThis.Date = FixedDate as any;
  const cases: any[] = [];
  for (const state of states) {
    const channelID = String(state.channelID), customerId = String(state.customerId);
    for (const [timeZone, maxDays, planTier] of [['UTC', 90, 'pro'], ['America/New_York', 30, 'free']] as const) {
      const window = receipts.resolveAiUsageWindow({ timeZone, now: new RealDate(NOW), maxDays });
      const status = await ledger.getAiUsageLedgerStatus({ channelID, customerId, startsAt: window.startTimestamp });
      const request = { channelID, customerId, planTier, accountCreatedAt: new RealDate(Date.UTC(2025, 0, 1)).toISOString(),
        window: { ...window, startTimestamp: window.startTimestamp.toISOString(), endTimestampExclusive: window.endTimestampExclusive.toISOString() } };
      const data = await dashboard.computeDashboard(request, new RealDate(NOW));
      const page = await queries.queryAiUsageTransactions({ channelID, customerId, window, limit: 25 });
      const next = page.nextCursor ? await queries.queryAiUsageTransactions({ channelID, customerId, window, limit: 25, cursor: page.nextCursor }) : null;
      cases.push({
        channelID, stateId: String(state._id), timeZone, maxDays, planTier,
        status: { status: status.status, sha: sha(status) },
        dashboard: { sha: sha(data), totalSpentCredits: data.summary.totalSpentCredits, transactionCount: data.summary.transactionCount, historyDays: data.history?.dayCount ?? null },
        page: { sha: sha(page), items: page.items.length, next: next ? { sha: sha(next), items: next.items.length } : null },
      });
    }
  }
  globalThis.Date = RealDate;
  await writeFile(output, JSON.stringify({ now: NOW, cases }, null, 2) + '\n');
  console.log(`recorded ${cases.length} real cases over ${states.length} ledger states`);
} finally {
  globalThis.Date = RealDate;
  await mongoose.disconnect();
  process.exit(0);
}
