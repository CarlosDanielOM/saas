/**
 * Messages between an assistant UI frame and the page. Pure: unit-tested with `node --test`.
 * Every message carries `dimaUi: 1` and the frame's token; the page also checks `event.source` (that frame's window).
 */
import { ASSISTANT_ROUTES } from '../assistant-routes';

/** Submitted values: a plain JSON object of at most this many UTF-8 bytes. */
export const MAX_SUBMIT_BYTES = 16 * 1024;
/** The frame grows with its content up to this height, then scrolls inside. */
export const MAX_FRAME_HEIGHT = 900;
export const MIN_FRAME_HEIGHT = 48;
const MAX_DEPTH = 12;

export type FrameMessage =
  | { type: 'ready'; height: number }
  | { type: 'resize'; height: number }
  | { type: 'submit'; values: Record<string, unknown> }
  | { type: 'navigate'; route: string }
  /** From the relay: the card tried to load another page (refused) and was removed. */
  | { type: 'stopped' };

/** Page → frame. */
export type HostMessage =
  | { type: 'theme'; theme: unknown }
  | { type: 'lock' }
  | { type: 'unlock' };

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Only JSON values: plain objects, arrays, strings, finite numbers, booleans and null. */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (isRecord(value)) return Object.keys(value).every((key) => isPlainJson(value[key], depth + 1));
  return false;
}

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export const clampFrameHeight = (height: number): number => Math.round(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, height)));

export const isRouteKey = (route: unknown): route is string => typeof route === 'string' && Object.hasOwn(ASSISTANT_ROUTES, route);

/** A message from the frame as the page may act on it, or null (wrong token, unknown type, bad payload). */
export function validateFrameMessage(data: unknown, token: string): FrameMessage | null {
  if (!isRecord(data) || data['dimaUi'] !== 1 || typeof token !== 'string' || !token || data['token'] !== token) return null;
  switch (data['type']) {
    case 'ready':
    case 'resize': {
      const height = data['height'];
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return null;
      return { type: data['type'], height: clampFrameHeight(height) };
    }
    case 'submit': {
      const values = data['values'];
      if (!isRecord(values) || !isPlainJson(values) || jsonBytes(values) > MAX_SUBMIT_BYTES) return null;
      return { type: 'submit', values };
    }
    case 'navigate': {
      const route = data['route'];
      return isRouteKey(route) ? { type: 'navigate', route } : null;
    }
    case 'stopped':
      return { type: 'stopped' };
    default:
      return null;
  }
}
