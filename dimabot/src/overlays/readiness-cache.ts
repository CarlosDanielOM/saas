/** Process-local, bounded coalescing for read-only Studio readiness checks. */
export class ReadinessCache<T> {
  private readonly entries = new Map<string, { promise: Promise<T>; expires: number }>();
  constructor(private readonly successMs: number, private readonly errorMs: number,
    private readonly maxEntries: number, private readonly now: () => number = Date.now) {}

  read(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > this.now()) return existing.promise;
    if (existing) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    const entry = { promise: undefined as unknown as Promise<T>, expires: Infinity };
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.expires = this.now() + this.successMs; return value;
    }, error => {
      entry.expires = this.now() + this.errorMs; throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }
  invalidate(key: string): void { this.entries.delete(key); }
}
