/**
 * `dima.chart(el, spec)` for assistant UI frames: accessible, theme-aware SVG charts.
 *
 * Both functions are inlined into the sandboxed frame as text (`.toString()`), so each must stay self-contained:
 * no imports, no references outside its own body, no object spread. `dimaChartMarkup` is pure (string in, string out)
 * and unit-tested in node; `dimaChartWire` adds the hover/keyboard tooltip inside the frame.
 *
 * Design (dataviz skill): one y-axis, hairline solid grid, bars ≤ 24px with 4px rounded data ends and 2px gaps, 2px
 * lines with ringed end dots, 10% area washes, a legend for 2+ series, selective direct labels (the peak bar, line
 * ends), text in text tokens, a crosshair/per-mark tooltip and a data table. Categorical order: violet (brand),
 * orange, aqua, yellow; validated with validate_palette.js on the site surfaces (light #ffffff, dark #171a21).
 */

export type ChartType = 'bar' | 'line' | 'area' | 'donut';

export interface ChartSpec {
  type?: ChartType | string;
  labels?: unknown;
  series?: unknown;
  unit?: unknown;
  title?: unknown;
}

export interface ChartOptions {
  width: number;
  height?: number;
  mode: 'dark' | 'light';
  locale?: string;
  id?: string;
  strings?: { table?: string; other?: string; total?: string; error?: string; series?: string; label?: string };
}

export interface ChartTooltipRow { title: string; items: { name: string; value: string; color: string }[] }
export interface ChartModel {
  type: ChartType;
  count: number;
  /** x centre of each index (px, chart coordinates); empty for donut. */
  xs: number[];
  plotTop: number;
  plotBottom: number;
  rows: ChartTooltipRow[];
}
export interface ChartResult { html: string; model: ChartModel | null }

/* eslint-disable @typescript-eslint/no-explicit-any */
export function dimaChartMarkup(spec: ChartSpec, opts: ChartOptions): ChartResult {
  const PALETTE: Record<string, string[]> = {
    light: ['#7c3aed', '#eb6834', '#1baf7a', '#eda100'],
    dark: ['#8b5cf6', '#d95926', '#199e70', '#c98500'],
  };
  const OTHER: Record<string, string> = { light: '#9aa0ab', dark: '#5b6270' };
  const strings = opts.strings || {};
  const mode = opts.mode === 'light' ? 'light' : 'dark';
  const colors = PALETTE[mode];
  const id = String(opts.id || 'dc').replace(/[^a-zA-Z0-9_-]/g, '');
  const locale = opts.locale || 'en';
  const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  const clip = (value: unknown, max: number) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  };
  const fail = (): ChartResult => ({ html: `<p class="dc-error" role="note">${esc(strings.error || 'This chart could not be drawn.')}</p>`, model: null });
  const r1 = (n: number) => Math.round(n * 10) / 10;

  // ---- validate the spec (it comes from the model: never trust shapes or sizes)
  const type: ChartType = spec && (spec.type === 'line' || spec.type === 'area' || spec.type === 'donut') ? spec.type : 'bar';
  const rawLabels = Array.isArray(spec && spec.labels) ? (spec.labels as unknown[]).slice(0, 60) : [];
  const labels = rawLabels.map((label) => clip(label, 60));
  const rawSeries = Array.isArray(spec && spec.series) ? (spec.series as unknown[]).slice(0, 4) : [];
  const series = rawSeries
    .filter((item) => item && typeof item === 'object')
    .map((item: any, index) => ({
      name: clip(item.name == null || item.name === '' ? (strings.series || 'Series') + ' ' + (index + 1) : item.name, 40),
      values: labels.map((_, i) => {
        const value = Array.isArray(item.values) ? item.values[i] : null;
        const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
        return Number.isFinite(n) ? n : null;
      }),
      color: colors[index],
    }));
  if (!labels.length || !series.length || !series.some((item) => item.values.some((v) => v !== null))) return fail();
  const unit = clip(spec.unit == null ? '' : spec.unit, 12);
  const title = clip(spec.title == null ? '' : spec.title, 80);

  const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const withUnit = (text: string) => !unit ? text : unit === '%' ? text + '%' : /^[$€£¥]$/.test(unit) ? unit + text : text + ' ' + unit;
  const fmt = (n: number) => withUnit(plain.format(n));

  const width = Math.max(220, Math.min(1200, Math.round(opts.width || 320)));
  const rows: ChartTooltipRow[] = [];
  let body = '';
  let legend = '';
  let xs: number[] = [];
  let plotTop = 0;
  let plotBottom = 0;
  let height = opts.height || (type === 'donut' ? 200 : 220);
  let summary = '';

  // ---- table view (always: it carries every value, including ones without a direct label)
  const tableHead = '<tr><th scope="col">' + esc(strings.label || '') + '</th>' + series.map((s) => `<th scope="col">${esc(s.name)}</th>`).join('') + '</tr>';
  const tableBody = labels.map((label, i) => '<tr><th scope="row">' + esc(label) + '</th>'
    + series.map((s) => `<td>${s.values[i] === null ? '—' : esc(fmt(s.values[i] as number))}</td>`).join('') + '</tr>').join('');
  const table = `<details class="dc-table"><summary>${esc(strings.table || 'Data table')}</summary><div class="dc-table__scroll"><table><thead>${tableHead}</thead><tbody>${tableBody}</tbody></table></div></details>`;

  if (type === 'donut') {
    // One series, labels as parts; more than 4 parts fold the smallest into "Other".
    const s = series[0];
    let parts = labels.map((label, i) => ({ label, value: Math.max(0, s.values[i] || 0), color: '' })).filter((p) => p.value > 0);
    if (!parts.length) return fail();
    parts.sort((a, b) => b.value - a.value);
    if (parts.length > 4) {
      const rest = parts.slice(3).reduce((sum, p) => sum + p.value, 0);
      parts = parts.slice(0, 3).concat([{ label: strings.other || 'Other', value: rest, color: OTHER[mode] }]);
    }
    parts.forEach((p, i) => { if (!p.color) p.color = colors[i]; });
    const total = parts.reduce((sum, p) => sum + p.value, 0);
    const size = Math.min(height, width);
    const cx = width / 2;
    const cy = size / 2;
    const outer = size / 2 - 6;
    const inner = outer * 0.62;
    let angle = -Math.PI / 2;
    const point = (r: number, a: number) => `${r1(cx + r * Math.cos(a))} ${r1(cy + r * Math.sin(a))}`;
    body += parts.map((p, i) => {
      const share = p.value / total;
      const sweep = Math.min(share * Math.PI * 2, Math.PI * 2 - 0.0001);
      const a0 = angle;
      const a1 = angle + sweep;
      angle = a1;
      const large = sweep > Math.PI ? 1 : 0;
      const d = `M${point(outer, a0)}A${r1(outer)} ${r1(outer)} 0 ${large} 1 ${point(outer, a1)}L${point(inner, a1)}A${r1(inner)} ${r1(inner)} 0 ${large} 0 ${point(inner, a0)}Z`;
      rows.push({ title: p.label, items: [{ name: Math.round(share * 100) + '%', value: fmt(p.value), color: p.color }] });
      return `<path class="dc-mark dc-seg" data-i="${i}" d="${d}" fill="${p.color}" stroke="var(--surface)" stroke-width="2" />`;
    }).join('');
    body += `<text class="dc-total" x="${r1(cx)}" y="${r1(cy - 2)}" text-anchor="middle">${esc(fmt(total))}</text>`
      + `<text class="dc-total-label" x="${r1(cx)}" y="${r1(cy + 16)}" text-anchor="middle">${esc(strings.total || 'Total')}</text>`;
    legend = '<ul class="dc-legend">' + parts.map((p) => `<li><span class="dc-key dc-key--box" style="background:${p.color}"></span>`
      + `<span>${esc(p.label)}</span> <b>${esc(fmt(p.value))}</b> <span class="dc-muted">${Math.round((p.value / total) * 100)}%</span></li>`).join('') + '</ul>';
    height = size;
    summary = parts.map((p) => `${p.label} ${fmt(p.value)}`).join(', ');
  } else {
    const values: number[] = [];
    series.forEach((s) => s.values.forEach((v) => { if (v !== null) values.push(v); }));
    let min = Math.min(0, Math.min.apply(null, values));
    let max = Math.max(0, Math.max.apply(null, values));
    if (min === max) max = min + 1;
    // Clean ticks: 1/2/2.5/5 × 10^n, about 4 intervals.
    const rough = (max - min) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) || rough;
    min = Math.floor(min / step) * step;
    max = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t / step) * step);
    const compact = Math.max(Math.abs(min), Math.abs(max)) >= 10000;
    const tickFmt = new Intl.NumberFormat(locale, compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 });
    const tickText = (n: number) => withUnit(tickFmt.format(n));
    const axisWidth = Math.min(72, Math.max(28, Math.max.apply(null, ticks.map((t) => tickText(t).length)) * 6.4 + 10));
    const left = axisWidth;
    // Lines keep room on the right for their end-value labels.
    const lastText = (s: { values: (number | null)[] }) => { const last = s.values.filter((v) => v !== null).pop(); return last == null ? '' : clip(fmt(last), 9); };
    const endRoom = type === 'bar' ? 8 : Math.min(72, Math.max.apply(null, series.map((s) => lastText(s).length)) * 6.4 + 14);
    const right = width - endRoom;
    plotTop = 14;
    plotBottom = height - 26;
    const y = (n: number) => plotBottom - ((n - min) / (max - min)) * (plotBottom - plotTop);
    const count = labels.length;
    const band = (right - left) / count;
    xs = labels.map((_, i) => left + band * (i + 0.5));

    // Grid + y ticks (hairline, solid, recessive).
    body += ticks.map((t) => `<line class="dc-grid${t === 0 ? ' dc-base' : ''}" x1="${r1(left)}" x2="${r1(right)}" y1="${r1(y(t))}" y2="${r1(y(t))}" />`
      + `<text class="dc-tick" x="${r1(left - 6)}" y="${r1(y(t) + 4)}" text-anchor="end">${esc(tickText(t))}</text>`).join('');
    // X labels: every nth so they never collide (about one per 56px), truncated to the space they get.
    const every = Math.max(1, Math.ceil(count / Math.max(1, Math.floor((right - left) / 56))));
    const maxChars = Math.max(3, Math.floor(Math.min(band * every, 140) / 6.4));
    body += labels.map((label, i) => i % every !== 0 ? ''
      : `<text class="dc-xlabel" x="${r1(xs[i])}" y="${r1(height - 8)}" text-anchor="middle">${esc(clip(label, maxChars))}</text>`).join('');

    if (type === 'bar') {
      const groups = series.length;
      const barWidth = Math.max(2, Math.min(24, (band * 0.72 - (groups - 1) * 2) / groups));
      const groupWidth = barWidth * groups + (groups - 1) * 2;
      const base = y(Math.max(min, Math.min(0, max)));
      series.forEach((s, si) => {
        let peak = -1;
        s.values.forEach((v, i) => { if (v !== null && (peak < 0 || v > (s.values[peak] as number))) peak = i; });
        s.values.forEach((v, i) => {
          if (v === null) return;
          const x = xs[i] - groupWidth / 2 + si * (barWidth + 2);
          const top = y(v);
          const up = v >= 0;
          const h = Math.abs(base - top);
          const r = Math.min(4, barWidth / 2, h);
          // Rounded at the data end, square at the baseline.
          const d = up
            ? `M${r1(x)} ${r1(base)}V${r1(top + r)}Q${r1(x)} ${r1(top)} ${r1(x + r)} ${r1(top)}H${r1(x + barWidth - r)}Q${r1(x + barWidth)} ${r1(top)} ${r1(x + barWidth)} ${r1(top + r)}V${r1(base)}Z`
            : `M${r1(x)} ${r1(base)}V${r1(top - r)}Q${r1(x)} ${r1(top)} ${r1(x + r)} ${r1(top)}H${r1(x + barWidth - r)}Q${r1(x + barWidth)} ${r1(top)} ${r1(x + barWidth)} ${r1(top - r)}V${r1(base)}Z`;
          body += `<path class="dc-mark dc-bar" data-i="${i}" d="${d}" fill="${s.color}" />`;
          // Selective direct label: each series' peak (one or two series only).
          if (i === peak && groups <= 2) body += `<text class="dc-value" x="${r1(x + barWidth / 2)}" y="${r1(up ? top - 5 : top + 13)}" text-anchor="middle">${esc(fmt(v))}</text>`;
        });
      });
    } else {
      const endLabels: { y: number; text: string; value: number }[] = [];
      series.forEach((s) => {
        const pts = s.values.map((v, i) => v === null ? null : { x: xs[i], y: y(v), v });
        let d = '';
        let open = false;
        pts.forEach((p) => {
          if (!p) { open = false; return; }
          d += (open ? 'L' : 'M') + r1(p.x) + ' ' + r1(p.y);
          open = true;
        });
        if (type === 'area') {
          // Wash under each unbroken run of points.
          let run: { x: number; y: number }[] = [];
          const flush = () => {
            if (run.length > 1) body += `<path class="dc-area" d="M${r1(run[0].x)} ${r1(y(Math.max(min, 0)))}${run.map((p) => 'L' + r1(p.x) + ' ' + r1(p.y)).join('')}L${r1(run[run.length - 1].x)} ${r1(y(Math.max(min, 0)))}Z" fill="${s.color}" fill-opacity="0.1" />`;
            run = [];
          };
          pts.forEach((p) => { if (p) run.push(p); else flush(); });
          flush();
        }
        body += `<path class="dc-mark dc-line" d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
        const last = pts.filter(Boolean).pop() as { x: number; y: number; v: number } | undefined;
        if (last) {
          body += `<circle class="dc-dot" cx="${r1(last.x)}" cy="${r1(last.y)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2" />`;
          endLabels.push({ y: last.y, text: lastText(s), value: last.v });
        }
      });
      // End labels that would collide are dropped (the tooltip and table still carry them).
      endLabels.sort((a, b) => b.value - a.value);
      const placed: number[] = [];
      endLabels.forEach((label) => {
        if (placed.some((py) => Math.abs(py - label.y) < 13)) return;
        placed.push(label.y);
        body += `<text class="dc-value" x="${r1(right + 8)}" y="${r1(label.y + 4)}" text-anchor="start">${esc(label.text)}</text>`;
      });
      body += `<line class="dc-cross" x1="0" x2="0" y1="${r1(plotTop)}" y2="${r1(plotBottom)}" />`;
    }
    // Hit areas: one band per label, full plot height (bigger than any mark).
    body += labels.map((_, i) => `<rect class="dc-hit" data-i="${i}" x="${r1(left + band * i)}" y="${r1(plotTop)}" width="${r1(band)}" height="${r1(plotBottom - plotTop)}" />`).join('');
    labels.forEach((label, i) => rows.push({ title: label, items: series.map((s) => ({ name: s.name, value: s.values[i] === null ? '—' : fmt(s.values[i] as number), color: s.color })) }));
    if (series.length > 1) {
      legend = '<ul class="dc-legend">' + series.map((s) => `<li><span class="dc-key ${type === 'bar' ? 'dc-key--box' : 'dc-key--line'}" style="background:${s.color}"></span><span>${esc(s.name)}</span></li>`).join('') + '</ul>';
    }
    summary = series.map((s) => {
      let hi = -1;
      s.values.forEach((v, i) => { if (v !== null && (hi < 0 || v > (s.values[hi] as number))) hi = i; });
      return hi < 0 ? s.name : `${s.name}: ${labels[hi]} ${fmt(s.values[hi] as number)}`;
    }).join('; ');
  }

  const kind = type;
  const name = (title ? title + '. ' : '') + summary;
  const svg = `<svg class="dc-svg" role="img" tabindex="0" aria-labelledby="${id}-t" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" data-type="${kind}">`
    + `<title id="${id}-t">${esc(clip(name, 400))}</title>${body}</svg>`;
  const caption = title ? `<figcaption class="dc-title">${esc(title)}</figcaption>` : '';
  const html = `<figure class="dc" data-type="${kind}">${caption}${legend}<div class="dc-plot">${svg}<div class="dc-tip" aria-hidden="true" hidden></div></div>${table}</figure>`;
  return { html, model: { type: kind, count: rows.length, xs, plotTop, plotBottom, rows } };
}

/** Inside the frame: hover/focus tooltip and crosshair for one rendered chart. Returns a cleanup function. */
export function dimaChartWire(root: any, model: ChartModel | null): () => void {
  if (!model || !root) return function () { /* nothing to undo */ };
  const svg = root.querySelector('.dc-svg');
  const tip = root.querySelector('.dc-tip');
  const cross = root.querySelector('.dc-cross');
  const plot = root.querySelector('.dc-plot');
  if (!svg || !tip || !plot) return function () { /* nothing to undo */ };
  let active = -1;
  const doc = root.ownerDocument;
  const show = (index: number) => {
    if (index < 0 || index >= model.count) return hide();
    active = index;
    const row = model.rows[index];
    tip.textContent = '';
    const head = doc.createElement('p');
    head.className = 'dc-tip__title';
    head.textContent = row.title;
    tip.appendChild(head);
    row.items.forEach((item) => {
      const line = doc.createElement('p');
      line.className = 'dc-tip__row';
      const key = doc.createElement('span');
      key.className = 'dc-tip__key';
      key.style.background = item.color;
      const value = doc.createElement('b');
      value.textContent = item.value;
      const name = doc.createElement('span');
      name.textContent = item.name;
      line.appendChild(key);
      line.appendChild(value);
      line.appendChild(name);
      tip.appendChild(line);
    });
    tip.hidden = false;
    svg.setAttribute('data-hover', '');
    svg.querySelectorAll('[data-i]').forEach((node: any) => node.classList.toggle('is-active', node.getAttribute('data-i') === String(index)));
    const scale = svg.getBoundingClientRect().width / (svg.viewBox.baseVal.width || 1);
    if (cross && model.xs.length) {
      cross.setAttribute('x1', String(model.xs[index]));
      cross.setAttribute('x2', String(model.xs[index]));
      cross.classList.add('is-on');
    }
    const plotWidth = plot.clientWidth;
    const x = model.xs.length ? model.xs[index] * scale : plotWidth / 2;
    const tipWidth = tip.offsetWidth;
    const leftPx = Math.max(0, Math.min(plotWidth - tipWidth, x + 12 + tipWidth > plotWidth ? x - tipWidth - 12 : x + 12));
    tip.style.transform = 'translate(' + Math.round(leftPx) + 'px, 0)';
  };
  const hide = () => {
    active = -1;
    tip.hidden = true;
    svg.removeAttribute('data-hover');
    svg.querySelectorAll('.is-active').forEach((node: any) => node.classList.remove('is-active'));
    if (cross) cross.classList.remove('is-on');
  };
  const onMove = (event: any) => {
    const hit = event.target && event.target.closest ? event.target.closest('[data-i]') : null;
    if (hit) show(Number(hit.getAttribute('data-i')));
  };
  // Touch fires pointerleave right after a tap: only mouse leaves clear the tooltip.
  const onLeave = (event: any) => { if (event.pointerType === 'mouse') hide(); };
  const onKey = (event: any) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); show(Math.min(model.count - 1, active + 1)); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); show(Math.max(0, active < 0 ? 0 : active - 1)); }
    else if (event.key === 'Home') { event.preventDefault(); show(0); }
    else if (event.key === 'End') { event.preventDefault(); show(model.count - 1); }
    else if (event.key === 'Escape') hide();
  };
  const onFocus = () => { if (active < 0) show(0); };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerdown', onMove);
  svg.addEventListener('pointerleave', onLeave);
  svg.addEventListener('keydown', onKey);
  svg.addEventListener('focus', onFocus);
  svg.addEventListener('blur', hide);
  return function () {
    svg.removeEventListener('pointermove', onMove);
    svg.removeEventListener('pointerdown', onMove);
    svg.removeEventListener('pointerleave', onLeave);
    svg.removeEventListener('keydown', onKey);
    svg.removeEventListener('focus', onFocus);
    svg.removeEventListener('blur', hide);
  };
}

export const DIMA_CHART_MARKUP_SOURCE = dimaChartMarkup.toString();
export const DIMA_CHART_WIRE_SOURCE = dimaChartWire.toString();
