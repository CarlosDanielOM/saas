import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

export interface TrendPoint {
  label: string;
  value: number;
}

/**
 * Single-series trend for dashboard mocks: one axis, recessive grid, 2px line
 * with a soft area, crosshair + tooltip on hover/focus. Values stay in text ink.
 */
@Component({
  selector: 'app-mock-trend-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="tc" [attr.aria-label]="label()">
      <div class="tc__axis" aria-hidden="true">
        @for (g of grid(); track g.y) {
          <span [style.top.%]="(g.y / H) * 100">{{ format()(g.value) }}</span>
        }
      </div>
      <div class="tc__plot">
        <svg
          class="tc__svg"
          [attr.viewBox]="'0 0 ' + W + ' ' + H"
          preserveAspectRatio="none"
          role="img"
          [attr.aria-label]="summary()"
          (pointermove)="onMove($event)"
          (pointerleave)="active.set(null)"
        >
          @for (g of grid(); track g.y) {
            <line class="tc__grid" x1="0" [attr.x2]="W" [attr.y1]="g.y" [attr.y2]="g.y" />
          }
          <path class="tc__area" [attr.d]="areaPath()" />
          <path class="tc__line" [attr.d]="linePath()" vector-effect="non-scaling-stroke" />
          @if (activePoint(); as p) {
            <line class="tc__cross" [attr.x1]="p.x" [attr.x2]="p.x" y1="0" [attr.y2]="H" vector-effect="non-scaling-stroke" />
          }
        </svg>
        @if (activePoint(); as p) {
          <span class="tc__dot" [style.left.%]="(p.x / W) * 100" [style.top.%]="(p.y / H) * 100" aria-hidden="true"></span>
          <span class="tc__tip" [style.left.%]="clampPct((p.x / W) * 100)" role="status">
            <strong>{{ format()(p.value) }}</strong> {{ unit() }}<br /><span>{{ p.label }}</span>
          </span>
        }
        @for (p of points(); track $index) {
          <button
            type="button"
            class="tc__key"
            [style.left.%]="(p.x / W) * 100"
            [attr.aria-label]="p.label + ': ' + format()(p.value) + ' ' + unit()"
            (focus)="active.set($index)"
            (blur)="active.set(null)"
          ></button>
        }
      </div>
      <div class="tc__x" aria-hidden="true">
        @for (t of ticks(); track t.label) {
          <span [style.left.%]="(t.x / W) * 100">{{ t.label }}</span>
        }
      </div>
    </figure>
  `,
  styles: `
    :host { display: block; }
    .tc { position: relative; display: grid; grid-template-columns: 2.6rem minmax(0, 1fr); margin: 0; }
    .tc__axis { position: relative; height: var(--tc-h, 11rem); }
    .tc__axis span { position: absolute; right: 0.45rem; transform: translateY(-50%); color: var(--muted); font-size: 0.68rem; font-variant-numeric: tabular-nums; }
    .tc__plot { position: relative; height: var(--tc-h, 11rem); }
    .tc__svg { display: block; width: 100%; height: 100%; overflow: visible; touch-action: pan-y; }
    .tc__grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .tc__area { fill: var(--accent-soft); stroke: none; }
    .tc__line { fill: none; stroke: var(--chart, #7c3aed); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .tc__cross { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
    .tc__dot {
      position: absolute; width: 10px; height: 10px; transform: translate(-50%, -50%);
      border-radius: 999px; background: var(--chart, #7c3aed); box-shadow: 0 0 0 2px var(--tile); pointer-events: none;
    }
    .tc__tip {
      position: absolute; bottom: calc(100% + 0.3rem); transform: translateX(-50%);
      padding: 0.35rem 0.55rem; border: 1px solid var(--line); border-radius: 0.6rem;
      color: var(--fg); background: var(--tile); box-shadow: var(--shadow);
      font-size: 0.76rem; line-height: 1.35; white-space: nowrap; pointer-events: none; z-index: 2;
    }
    .tc__tip span { color: var(--muted); }
    .tc__x { position: relative; grid-column: 2; height: 1.3rem; }
    .tc__x span { position: absolute; top: 0.3rem; transform: translateX(-50%); color: var(--muted); font-size: 0.68rem; white-space: nowrap; }
    .tc__key { position: absolute; top: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; }
  `
})
export class MockTrendChartComponent {
  readonly data = input.required<TrendPoint[]>();
  readonly label = input('');
  readonly unit = input('');
  readonly format = input<(v: number) => string>((v) => Math.round(v).toLocaleString('en'));

  readonly W = 600;
  readonly H = 200;
  readonly active = signal<number | null>(null);

  private readonly max = computed(() => {
    const peak = Math.max(1, ...this.data().map((p) => p.value));
    const step = Math.pow(10, Math.floor(Math.log10(peak)));
    return Math.ceil(peak / step) * step;
  });

  readonly points = computed(() => {
    const data = this.data();
    const n = Math.max(1, data.length - 1);
    return data.map((p, i) => ({ ...p, x: (i / n) * this.W, y: this.H - (p.value / this.max()) * this.H }));
  });

  readonly grid = computed(() => [0, 0.5, 1].map((f) => ({ y: this.H - f * this.H, value: f * this.max() })));

  readonly ticks = computed(() => {
    const pts = this.points();
    if (pts.length < 2) return [];
    const every = Math.max(1, Math.round(pts.length / 4));
    return pts.filter((_, i) => i % every === 0 && i < pts.length - every / 2).map((p) => ({ x: p.x, label: p.label }));
  });

  readonly linePath = computed(() => this.points().map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  readonly areaPath = computed(() => {
    const pts = this.points();
    if (!pts.length) return '';
    return `${this.linePath()} L${this.W},${this.H} L0,${this.H} Z`;
  });

  readonly activePoint = computed(() => {
    const i = this.active();
    return i === null ? null : (this.points()[i] ?? null);
  });

  readonly summary = computed(() => {
    const data = this.data();
    if (!data.length) return this.label();
    const peak = data.reduce((a, b) => (b.value > a.value ? b : a));
    return `${this.label()}: ${data[0].label} – ${data[data.length - 1].label}. Peak ${this.format()(peak.value)} ${this.unit()} on ${peak.label}.`;
  });

  onMove(event: PointerEvent): void {
    const svg = event.currentTarget as SVGElement;
    const rect = svg.getBoundingClientRect();
    const n = this.points().length;
    if (!n || !rect.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    this.active.set(Math.round(ratio * (n - 1)));
  }

  clampPct(pct: number): number {
    return Math.min(88, Math.max(12, pct));
  }
}
