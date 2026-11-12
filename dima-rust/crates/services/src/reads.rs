//! Read services of the dashboard: AI credit display, AI usage dashboard and queries, dashboard
//! activity and insights, and the request rate limit. Package **P4-SVC-READS** fills this module;
//! it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai_credit_display.ts` (52 lines): `getFreeAiCreditDisplay`
//! - `utils/ai_usage_dashboard.ts` (117 lines): `getAiUsageDashboard`
//! - `utils/ai_usage_queries.ts` (70 lines): `queryAiUsageTransactions`, `usageLedgerStatus`
//! - `utils/dashboard_activity.ts` (115 lines): `queueDashboardActivity`
//! - `utils/dashboard_insights.ts` (131 lines): `queueDashboardInsights`
//! - `utils/rate_limit.ts` (21 lines): `hitRateLimit`
