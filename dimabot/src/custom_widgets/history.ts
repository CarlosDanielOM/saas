/**
 * Which revisions a widget document keeps (the code editor's version history). The latest and any revision a
 * published overlay pins are always kept; besides those, the newest revisions up to `count` (the latest included),
 * while the whole set stays within a stored-size budget so the document stays far from MongoDB's 16 MB limit.
 */
export const HISTORY_REVISIONS = 10;
export const HISTORY_BYTES = 6_000_000;

export function keptRevisions<R extends { revision: number }>(revisions: readonly R[], latest: number, pinned: (revision: number) => boolean,
  sizeOf: (revision: R) => number, limits: { count: number; bytes: number } = { count: HISTORY_REVISIONS, bytes: HISTORY_BYTES }): R[] {
  const keep = new Set<number>();
  let bytes = 0;
  // Always-kept revisions take their room first, so optional history never pushes the set over the budget.
  for (const r of revisions) if (r.revision === latest || pinned(r.revision)) { keep.add(r.revision); bytes += sizeOf(r); }
  let count = 0;
  for (const r of [...revisions].sort((a, b) => b.revision - a.revision)) {
    if (count >= limits.count) break;
    count++;
    if (keep.has(r.revision)) continue;
    const size = sizeOf(r);
    if (bytes + size > limits.bytes) break;
    bytes += size; keep.add(r.revision);
  }
  return revisions.filter(r => keep.has(r.revision));
}
