export * from 'real:utils/siteanalytics.ts';
import { record, track } from './rec.mjs';
export function incrementSiteAnalytics(filter, value = 1) {
  record('site', { filter, value });
  return track(Promise.resolve());
}
