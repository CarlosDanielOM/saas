export * from 'real:utils/logger.ts';
import { R } from './rec.mjs';
// Logs are counted by level, not written (no `logger:*` keys, nothing printed).
const level = (name) => async (data) => {
  R.logs ??= {};
  R.logs[name] = (R.logs[name] ?? 0) + 1;
  return { error: false };
};
export const trace = level('trace');
export const debug = level('debug');
export const info = level('info');
export const warn = level('warn');
export const error = level('error');
export const fatal = level('fatal');
