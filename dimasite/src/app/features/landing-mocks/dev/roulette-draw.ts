/** Bounds the rendered wheel data, not the weight of an item. */
export const MAX_DRAW_SLOTS = 10_000;
export interface WeightedEntry {
  id: number;
  weight: number;
  multiplier: number;
}
export interface DrawSlot extends WeightedEntry {
  key: string;
  copy: number;
  index: number;
}
export class DrawConfigurationError extends Error {
  readonly code: 'number' | 'capacity' | 'total' | 'format';
  constructor(code: 'number' | 'capacity' | 'total' | 'format') {
    super(code);
    this.code = code;
  }
}
export function drawTotals(entries: readonly WeightedEntry[]): { slots: number; weight: number } {
  let slots = 0;
  let weight = 0;
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.weight) ||
      entry.weight < 1 ||
      !Number.isSafeInteger(entry.multiplier) ||
      entry.multiplier < 1
    ) {
      throw new DrawConfigurationError('number');
    }
    slots += entry.multiplier;
    if (slots > MAX_DRAW_SLOTS) throw new DrawConfigurationError('capacity');
    const contribution = entry.weight * entry.multiplier;
    weight += contribution;
    if (!Number.isSafeInteger(contribution) || !Number.isSafeInteger(weight)) {
      throw new DrawConfigurationError('total');
    }
  }
  return { slots, weight };
}
export function expandSlots(entries: readonly WeightedEntry[]): DrawSlot[] {
  drawTotals(entries);
  const slots: DrawSlot[] = [];
  for (const entry of entries) {
    for (let copy = 1; copy <= entry.multiplier; copy++) {
      slots.push({ ...entry, key: `${entry.id}:${copy}`, copy, index: slots.length });
    }
  }
  return slots;
}
/** Each slot owns exactly `weight` integer tickets in [0, total). */
export function selectSlot(slots: readonly DrawSlot[], ticket: number): DrawSlot {
  if (!Number.isSafeInteger(ticket) || ticket < 0) throw new RangeError('Invalid ticket');
  let remaining = ticket;
  for (const slot of slots) {
    if (remaining < slot.weight) return slot;
    remaining -= slot.weight;
  }
  throw new RangeError('Ticket outside the draw');
}
function random53Bits(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (words[0] & 0x1fffff) * 0x100000000 + words[1];
}
/** Rejection sampling avoids modulo bias for arbitrary safe-integer totals. */
export function randomTicket(total: number, source: () => number = random53Bits): number {
  if (!Number.isSafeInteger(total) || total < 1) throw new RangeError('Invalid total');
  const range = 2 ** 53;
  const accepted = Math.floor(range / total) * total;
  let value: number;
  do {
    value = source();
  } while (value >= accepted);
  return value % total;
}
export function parseBulkEntries(
  text: string,
): Array<{ name: string; weight: number; multiplier: number }> {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const fields = line.split('\t').map((field) => field.trim());
      if (fields.length > 3 || !fields[0] || fields[0].length > 120) {
        throw new DrawConfigurationError('format');
      }
      const entry = {
        name: fields[0],
        weight: fields[1] ? Number(fields[1]) : 1,
        multiplier: fields[2] ? Number(fields[2]) : 1,
      };
      drawTotals([{ ...entry, id: 0 }]);
      return entry;
    });
}
