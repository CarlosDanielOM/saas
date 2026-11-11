// Run: cd dimabot && node --import tsx --test ../dimasite/src/app/features/assistant/ui-frame/*.spec.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { DIMA_CHART_MARKUP_SOURCE, dimaChartMarkup } from './ui-chart.ts';

const opts = { width: 480, mode: 'dark' as const, locale: 'en', id: 't1' };
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

test('bar: accessible SVG, ≤24px bars with rounded data ends, peak label, table, tooltip rows', () => {
  const { html, model } = dimaChartMarkup({ type: 'bar', title: 'Messages per day', labels: ['Mon', 'Tue', 'Wed'], series: [{ name: 'Messages', values: [120, 340, 90] }] }, opts);
  assert.match(html, /<svg class="dc-svg" role="img" tabindex="0" aria-labelledby="t1-t"/);
  assert.match(html, /<title id="t1-t">Messages per day\. Messages: Tue 340<\/title>/);
  assert.equal(count(html, /class="dc-mark dc-bar"/g), 3);
  for (const [, d] of html.matchAll(/class="dc-mark dc-bar" data-i="\d" d="([^"]+)"/g)) {
    const xs = [...d.matchAll(/[MHQ]\s?([\d.]+)/g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 24.01, 'bar width ≤ 24px');
    assert.ok(d.includes('Q'), 'rounded data end');
  }
  assert.equal(count(html, /class="dc-value"/g), 1, 'only the peak is labelled');
  assert.match(html, /class="dc-value"[^>]*>340</);
  assert.ok(!html.includes('dc-legend'), 'one series: the title names it, no legend box');
  assert.match(html, /<details class="dc-table"><summary>Data table<\/summary>/);
  assert.equal(count(html, /<tr><th scope="row">/g), 3);
  assert.equal(model?.count, 3);
  assert.deepEqual(model?.rows[1], { title: 'Tue', items: [{ name: 'Messages', value: '340', color: '#8b5cf6' }] });
  assert.equal(count(html, /class="dc-hit"/g), 3, 'hit band per label');
});

test('palette follows the theme in fixed order; legend for 2+ series', () => {
  const spec = { type: 'line', labels: ['a', 'b'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [2, 1] }, { name: 'C', values: [3, 3] }, { name: 'D', values: [0, 4] }, { name: 'E', values: [1, 1] }] };
  const dark = dimaChartMarkup(spec, opts).html;
  const light = dimaChartMarkup(spec, { ...opts, mode: 'light' }).html;
  const strokes = (html: string) => [...html.matchAll(/class="dc-mark dc-line"[^>]*stroke="(#[0-9a-f]+)"/g)].map((m) => m[1]);
  assert.deepEqual(strokes(dark), ['#8b5cf6', '#d95926', '#199e70', '#c98500'], 'max 4 series, dark steps');
  assert.deepEqual(strokes(light), ['#7c3aed', '#eb6834', '#1baf7a', '#eda100']);
  assert.equal(count(dark, /<li><span class="dc-key dc-key--line"/g), 4);
  assert.ok(!dark.includes('>E<'), 'fifth series dropped');
  assert.equal(count(dark, /stroke-width="2" stroke-linejoin="round"/g), 4, '2px lines');
  assert.equal(count(dark, /class="dc-dot"[^>]*r="4"[^>]*stroke="var\(--surface\)" stroke-width="2"/g), 4, 'ringed end dots');
  assert.match(dark, /class="dc-cross"/);
});

test('area: 10% wash; gaps in data split the line', () => {
  const { html } = dimaChartMarkup({ type: 'area', labels: ['1', '2', '3', '4'], series: [{ name: 'Viewers', values: [5, null, 7, 9] }] }, opts);
  assert.match(html, /class="dc-area"[^>]*fill-opacity="0.1"/);
  const d = html.match(/class="dc-mark dc-line" d="([^"]+)"/)![1];
  assert.equal(count(d, /M/g), 2, 'null starts a new segment');
});

test('donut: parts with gaps, total, "Other" beyond 4, legend with shares', () => {
  const { html, model } = dimaChartMarkup({
    type: 'donut', title: 'Bits by source', unit: 'Bits', labels: ['Cheers', 'Alerts', 'Polls', 'Ads', 'Misc'],
    series: [{ name: 'Bits', values: [500, 300, 100, 60, 40] }],
  }, { ...opts, strings: { other: 'Other', total: 'Total' } });
  assert.equal(count(html, /class="dc-mark dc-seg"/g), 4);
  assert.match(html, /stroke="var\(--surface\)" stroke-width="2"/);
  assert.match(html, /class="dc-total"[^>]*>1,000 Bits</);
  assert.match(html, /<span>Other<\/span> <b>100 Bits<\/b> <span class="dc-muted">10%<\/span>/);
  assert.equal(model?.rows.length, 4);
});

test('untrusted labels are escaped; bad specs show a note', () => {
  const { html } = dimaChartMarkup({ type: 'bar', title: '<img src=x onerror=alert(1)>', labels: ['<script>x</script>'], series: [{ name: '"><b>', values: [1] }] }, opts);
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('"><b>'));
  assert.ok(html.includes('&lt;script&gt;'));
  for (const bad of [{}, { labels: [] }, { labels: ['a'], series: [] }, { labels: ['a'], series: [{ values: ['x'] }] }, { type: 'donut', labels: ['a'], series: [{ values: [0] }] }]) {
    const result = dimaChartMarkup(bad, { ...opts, strings: { error: 'No chart' } });
    assert.equal(result.model, null);
    assert.match(result.html, /class="dc-error" role="note">No chart</);
  }
});

test('axis ticks are clean and compact past 10,000; units and locale', () => {
  const { html } = dimaChartMarkup({ type: 'bar', labels: ['a', 'b'], series: [{ values: [12000, 48000] }], unit: '%' }, opts);
  const ticks = [...html.matchAll(/class="dc-tick"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(ticks, ['0%', '20K%', '40K%', '60K%'], '1/2/2.5/5 steps, compact');
  const es = dimaChartMarkup({ type: 'bar', labels: ['a'], series: [{ values: [1234.5] }], unit: '$' }, { ...opts, locale: 'es-MX' }).html;
  assert.match(es, /class="dc-value"[^>]*>\$1,234\.5</);
});

test('the injected source is self-contained (runs from its text alone)', () => {
  // tsx (esbuild keepNames) adds `__name(...)` calls; the Angular build doesn't (the browser check runs the real bundle).
  const fn = new Function('__name', `return (${DIMA_CHART_MARKUP_SOURCE});`)((target: unknown) => target);
  const { html } = fn({ type: 'bar', labels: ['a'], series: [{ values: [1] }] }, opts);
  assert.match(html, /<figure class="dc" data-type="bar">/);
});
