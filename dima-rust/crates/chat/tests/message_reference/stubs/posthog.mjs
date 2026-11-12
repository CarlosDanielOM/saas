export * from 'real:utils/posthog_events.ts';
import { record, copy } from './rec.mjs';
export function trackCommand(params) {
  record('product.command', copy(params));
}
