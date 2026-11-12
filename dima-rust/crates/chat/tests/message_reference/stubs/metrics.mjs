export * from 'real:utils/observability/bot_runtime_metrics.ts';
import { R } from './rec.mjs';
export function startMessageHandlerMetric() {
  R.metrics.started += 1;
  return { startedAt: Date.now() };
}
export function endMessageHandlerMetric(_tracker, failed) {
  R.metrics.ended += 1;
  if (failed) R.metrics.failed += 1;
}
export function recordRedisOpsEstimate() {}
