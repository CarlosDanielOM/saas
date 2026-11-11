/**
 * Applies a streamed text delta at its offset (wire contract: `offset` = length of the text before the delta).
 * Returns the new text, the same text when the delta is already covered (a replay), or null when text is
 * missing before the offset (the caller resyncs from the snapshot).
 */
export function applyTextDelta(text: string, delta: string, offset: number | undefined): string | null {
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return text + delta;
  if (text.length === offset) return text + delta;
  if (text.length >= offset + delta.length) return text;
  if (text.length > offset) return text.slice(0, offset) + delta;
  return null;
}
