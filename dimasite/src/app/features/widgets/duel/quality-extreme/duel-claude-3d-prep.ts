/**
 * Battle preparation, spread over frames. A battle's heavy one-off work (baking frozen poses,
 * compiling shaders) runs a little at a time between frames, long before the ultimate needs
 * it, instead of in one long stall at the start or in the middle of the finisher.
 */
export interface PrepJob {
  name: string;
  /** Do the work. A returned promise holds the queue (no blocking) until it settles. */
  run(): void | Promise<unknown>;
  /** Blocking fallback when the queue must finish immediately (defaults to run). */
  now?(): void;
}

export class PrepQueue {
  private jobs: PrepJob[] = [];
  private waiting = false;
  private generation = 0;
  /** Jobs finished for the current battle, and the longest synchronous one (telemetry). */
  ran = 0;
  slowest = { name: '', ms: 0 };

  constructor(private readonly done: () => void, private readonly clock: () => number = () => performance.now()) {}

  get idle(): boolean { return this.jobs.length === 0 && !this.waiting; }
  get pending(): number { return this.jobs.length + (this.waiting ? 1 : 0); }

  /** Replace the queue (a new battle); work still in flight for the old battle is ignored. */
  reset(jobs: PrepJob[]): void {
    this.generation++; this.jobs = [...jobs]; this.waiting = false; this.ran = 0; this.slowest = { name: '', ms: 0 };
    if (!this.jobs.length) this.done();
  }

  /** Queue more work for the current battle (runs next, before anything already queued). */
  add(jobs: PrepJob[]): void { this.jobs.unshift(...jobs); }

  /** Run jobs until the time budget is spent (always at least one). */
  step(budgetMs: number): void {
    if (this.waiting || !this.jobs.length) return;
    const start = this.clock();
    do {
      const job = this.jobs.shift()!, began = this.clock(), result = job.run(), ms = this.clock() - began;
      if (ms > this.slowest.ms) this.slowest = { name: job.name, ms };
      if (result instanceof Promise) {
        const generation = this.generation; this.waiting = true;
        const settle = () => { if (generation !== this.generation) return; this.waiting = false; this.ran++; if (this.idle) this.done(); };
        result.then(settle, settle);
        return;
      }
      this.ran++;
    } while (this.jobs.length && this.clock() - start < budgetMs);
    if (this.idle) this.done();
  }

  /** Finish everything now, blocking: something that needs the results is about to draw. */
  flush(): void {
    if (this.idle) return;
    this.generation++; this.waiting = false;
    while (this.jobs.length) { const job = this.jobs.shift()!; (job.now ?? job.run).call(job); this.ran++; }
    this.done();
  }
}
