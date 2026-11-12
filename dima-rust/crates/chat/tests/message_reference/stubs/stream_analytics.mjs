// The real recorders, with the handler's fire-and-forget calls tracked until they settle.
export * from 'real:utils/stream_analytics.ts';
import * as real from 'real:utils/stream_analytics.ts';
import { track } from './rec.mjs';
export const recordStreamMessageEvent = (...args) => track(real.recordStreamMessageEvent(...args));
export const recordStreamCommandEvent = (...args) => track(real.recordStreamCommandEvent(...args));
