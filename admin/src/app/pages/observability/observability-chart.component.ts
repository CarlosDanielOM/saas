import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import type { Point } from './observability-infra';

export interface ChartSeries {
  label: string;
  /** Colour slot from the validated palette: 1 or 2. */
  slot: 1 | 2;
  points: Point[];
}

const W = 300;
const H = 96;
const TOP = 6;

/**
 * Small trend chart: a 2px average line with a soft band up to the slot's peak, an optional
 * limit line, and a crosshair + tooltip on hover or touch. One y-axis only.
 */
@Component({
  selector: 'app-obs-chart',
  imports: [DatePipe],
  templateUrl: './observability-chart.component.html',
  styleUrl: './observability-chart.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObservabilityChartComponent {
  readonly title = input.required<string>();
  readonly series = input.required<ChartSeries[]>();
  readonly format = input.required<(value: number) => string>();
  readonly from = input.required<number>();
  readonly to = input.required<number>();
  /** Expected spacing between points in ms; larger gaps break the line instead of bridging it. */
  readonly step = input(60000);
  readonly limit = input<number | null>(null);
  readonly limitLabel = input('Limit');
  readonly floor = input(0);
  /** Round the axis top in powers of 1024 (bytes) instead of 10. */
  readonly binary = input(false);

  readonly w = W;
  readonly h = H;
  readonly hover = signal<number | null>(null);

  readonly max = computed(() => {
    let top = this.floor();
    for (const s of this.series()) for (const p of s.points) top = Math.max(top, p[2]);
    const limit = this.limit();
    if (limit && limit < top * 4) top = Math.max(top, limit);
    if (!this.binary() || top < 1024) return nice(top);
    const unit = 1024 ** Math.floor(Math.log(top) / Math.log(1024));
    return nice(top / unit) * unit;
  });
  readonly hasData = computed(() => this.series().some((s) => s.points.length > 0));
  readonly lines = computed(() => {
    const span = Math.max(1, this.to() - this.from());
    const x = (t: number) => ((t - this.from()) / span) * W;
    const y = (v: number) => H - (v / this.max()) * (H - TOP);
    const gap = this.step() * 2.5;
    return this.series().map((s) => {
      const runs: Point[][] = [];
      for (const p of s.points) {
        const run = runs[runs.length - 1];
        if (!run || p[0] - run[run.length - 1][0] > gap) runs.push([p]);
        else run.push(p);
      }
      const line = runs.map((run) => run.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')).join(' ');
      // Band between average and peak, so a short spike stays visible on long ranges.
      const band = runs
        .filter((run) => run.length > 1)
        .map((run) => run.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`).join(' ') + ' ' +
          [...run].reverse().map((p) => `L${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ') + ' Z')
        .join(' ');
      const dots = runs.filter((run) => run.length === 1).map((run) => ({ x: x(run[0][0]), y: y(run[0][1]) }));
      return { slot: s.slot, label: s.label, line, band, dots };
    });
  });
  readonly limitY = computed(() => {
    const limit = this.limit();
    return limit && limit <= this.max() ? H - (limit / this.max()) * (H - TOP) : null;
  });
  /** All timestamps across series, for the crosshair. */
  readonly times = computed(() => [...new Set(this.series().flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b));
  readonly tip = computed(() => {
    const i = this.hover();
    const times = this.times();
    if (i === null || !times.length) return null;
    const at = times[Math.min(i, times.length - 1)];
    const span = Math.max(1, this.to() - this.from());
    const left = ((at - this.from()) / span) * 100;
    return {
      at,
      left: Math.max(0, Math.min(100, left)),
      flip: left > 60,
      rows: this.series().map((s) => {
        const p = s.points.find((point) => point[0] === at);
        return { label: s.label, slot: s.slot, avg: p ? this.format()(p[1]) : '—', peak: p && p[2] > p[1] * 1.05 ? this.format()(p[2]) : null };
      }),
    };
  });
  readonly summary = computed(() => {
    const parts = this.series().map((s) => {
      if (!s.points.length) return `${s.label}: no data`;
      const avg = s.points.reduce((sum, p) => sum + p[1], 0) / s.points.length;
      const peak = Math.max(...s.points.map((p) => p[2]));
      return `${s.label}: average ${this.format()(avg)}, peak ${this.format()(peak)}`;
    });
    return `${this.title()}. ${parts.join('; ')}.`;
  });
  readonly axisTop = computed(() => this.format()(this.max()));
  readonly longRange = computed(() => this.to() - this.from() > 86400000 * 2);
  readonly startLabel = computed(() => {
    const hours = (this.to() - this.from()) / 3600000;
    return hours < 1 ? `${Math.round(hours * 60)} min ago` : hours <= 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} days ago`;
  });

  pointer(event: PointerEvent): void {
    const times = this.times();
    if (!times.length) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const t = this.from() + ((event.clientX - rect.left) / Math.max(1, rect.width)) * (this.to() - this.from());
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    this.hover.set(best);
  }
  /** Touch fires pointerleave right after a tap: keep the tooltip until the chart loses focus. */
  leave(event: PointerEvent): void {
    if (event.pointerType === 'mouse') this.hover.set(null);
  }
  key(event: KeyboardEvent): void {
    const n = this.times().length;
    if (!n) return;
    const i = this.hover() ?? n - 1;
    if (event.key === 'ArrowLeft') this.hover.set(Math.max(0, i - 1));
    else if (event.key === 'ArrowRight') this.hover.set(Math.min(n - 1, i + 1));
    else if (event.key === 'Escape') this.hover.set(null);
    else return;
    event.preventDefault();
  }
}

function nice(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}
