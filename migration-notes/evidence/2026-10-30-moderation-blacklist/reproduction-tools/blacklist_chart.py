#!/usr/bin/env python3
"""Render the five retained paired benchmark reports as a self-contained HTML file."""
import json
import statistics
from pathlib import Path

WAVE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/moderation-blacklist')
OUTPUT = WAVE / 'blacklist-benchmarks.html'
ROUNDS = [
    ('Initial · 4,000 iterations', 'attempt1/paired1'),
    ('ASCII fast path · 4,000 iterations', 'attempt2/paired1'),
    ('Long-input prefilter · 4,000 iterations', 'attempt3/paired1'),
    ('Long-input prefilter · 40,000 iterations', 'attempt3/stability-paired1'),
    ('All-length prefilter · 40,000 iterations', 'attempt4/paired1'),
]
COUNTS = {'short': 2, 'long': 1, 'many': 2, 'unicode': 2}


def read_round(label, directory):
    report = json.loads((WAVE / directory / 'blacklist-paired-report.json').read_text())
    if report['status'] != 'passed' or set(report['workloads']) != set(COUNTS):
        raise ValueError(f'incomplete report: {directory}')
    iterations = report['iterations']
    result = {'label': label, 'iterations': iterations, 'workloads': {}}
    for name, count in COUNTS.items():
        workload = report['workloads'][name]
        samples = workload['samples']
        operations = workload['expected']['operations']
        if len(samples) != 7 or operations != count * iterations:
            raise ValueError(f'unexpected trial or operation count: {directory}/{name}')
        actors = {}
        for actor in ('node', 'rust'):
            trials = []
            for sample in samples:
                run = sample[actor]
                if run['operations'] != operations or run['iterations'] != iterations:
                    raise ValueError(f'inconsistent sample: {directory}/{name}/{actor}')
                trials.append(int(run['nanoseconds']) / operations)
            median = statistics.median(trials)
            metric = workload['metrics'][actor]
            if abs(median - metric['medianNsPerOperation']) > 1e-6:
                raise ValueError(f'median mismatch: {directory}/{name}/{actor}')
            actors[actor] = {'trials': trials, 'median': median, 'min': min(trials), 'max': max(trials)}
        result['workloads'][name] = {'operations': operations, 'actors': actors}
    return result


def main():
    data = [read_round(label, directory) for label, directory in ROUNDS]
    payload = json.dumps(data, separators=(',', ':'), ensure_ascii=True).replace('<', '\\u003c')
    html = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blacklist benchmark comparisons</title>
<style>
:root { color-scheme: light dark; font-family: var(--font-sans, system-ui, sans-serif); color: var(--foreground, CanvasText); }
html, body, main { margin: 0; padding: 0; background: transparent; }
main { width: 100%; }
p { margin: 0; }
.controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; font-size: 14px; }
select { font: inherit; color: var(--foreground, CanvasText); background: Canvas; border: 1px solid var(--border, GrayText); border-radius: var(--radius, 6px); padding: 6px 8px; max-width: 100%; }
.caption, .detail, .method { color: var(--muted-foreground, var(--foreground, GrayText)); font-size: 13px; line-height: 1.5; }
.caption { margin-bottom: 12px; }
.charts { display: grid; gap: 12px; }
.chart { border: 1px solid var(--border, GrayText); border-radius: var(--radius, 8px); padding: 16px; min-width: 0; }
.chart-heading { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; align-items: baseline; }
h2 { font-size: 15px; line-height: 1.3; margin: 0; }
.effect { font-size: 13px; font-weight: 600; }
.detail { margin-top: 3px; }
svg { display: block; width: 100%; height: 80px; overflow: visible; }
svg text { fill: var(--foreground, CanvasText); font: 12px var(--font-sans, system-ui, sans-serif); }
.axis { stroke: var(--border, GrayText); stroke-width: 1; }
.node { stroke: var(--chart-1, LinkText); fill: var(--chart-1, LinkText); }
.rust { stroke: var(--chart-2, Mark); fill: var(--chart-2, Mark); }
.range { stroke-width: 4; stroke-linecap: round; }
.point { stroke: Canvas; stroke-width: 1.5; }
.values { display: grid; gap: 3px; font: 12px/1.45 var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.values span { font-family: var(--font-sans, system-ui, sans-serif); font-weight: 600; }
details { margin-top: 9px; font-size: 12px; }
summary { cursor: pointer; color: var(--muted-foreground, var(--foreground, GrayText)); }
.trials { margin-top: 6px; font: 12px/1.5 var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.method { margin-top: 14px; }
.method p + p { margin-top: 8px; }
</style>
</head>
<body>
<main>
<div class="controls"><label for="round">Benchmark round</label><select id="round"></select></div>
<p class="caption">Lower time is better. Each chart uses its own scale; dots show medians and lines show the seven-trial minimum–maximum range.</p>
<div id="charts" class="charts"></div>
<div class="method"><p>Each workload uses seven alternating pairs of fresh actors, with three in-process warmups per actor. Timed work includes folding, evaluation and retaining results; compilation, preparation, parsing, checksum, serialization and dropping results are outside the timer.</p><p>The many-term pool has a 97-term hit and a 96-term miss. The case named “many-late” is not a late alternative in TypeScript: sorting puts the target first. Results describe these measured workloads only; they do not establish CPU, memory, end-to-end or production performance, or statistical significance.</p></div>
</main>
<script>
const rounds = __DATA__;
const names = {short: ['Short inputs', '2 cases'], long: ['Long input', '1 case'], many: ['Many terms', '2 cases · 97-term hit / 96-term miss'], unicode: ['Unicode inputs', '2 cases']};
const select = document.getElementById('round');
const charts = document.getElementById('charts');
const number = n => n.toLocaleString('en-US', {maximumFractionDigits: 2});
rounds.forEach((round, i) => { const option = document.createElement('option'); option.value = i; option.textContent = round.label; select.append(option); });
select.value = String(rounds.length - 1);
function render() {
  const round = rounds[Number(select.value)];
  charts.replaceChildren();
  for (const [key, [title, description]] of Object.entries(names)) {
    const workload = round.workloads[key];
    const a = workload.actors.node, b = workload.actors.rust;
    const percent = (b.median / a.median - 1) * 100;
    const effect = Math.abs(percent) < 0.005 ? 'Same median time' : `${number(Math.abs(percent))}% ${percent < 0 ? 'less' : 'more'} time for Rust`;
    const max = Math.max(a.max, b.max) * 1.04;
    const x = value => 95 + (value / max) * 295;
    const marks = (actor, row, label, cls) => `<text x="0" y="${row + 4}">${label}</text><line class="axis" x1="95" x2="390" y1="${row}" y2="${row}"/><line class="range ${cls}" x1="${x(actor.min)}" x2="${x(actor.max)}" y1="${row}" y2="${row}"/><circle class="point ${cls}" cx="${x(actor.median)}" cy="${row}" r="5"/>`;
    const values = (label, actor) => `<div><span>${label}</span> median ${number(actor.median)} ns/op · range ${number(actor.min)}–${number(actor.max)} ns/op</div>`;
    const trialValues = (label, actor) => `<div>${label}: ${actor.trials.map(number).join(', ')} ns/op</div>`;
    const card = document.createElement('section'); card.className = 'chart';
    card.innerHTML = `<div class="chart-heading"><h2>${title}</h2><span class="effect">${effect}</span></div><p class="detail">${description} · ${workload.operations.toLocaleString('en-US')} operations per trial</p><svg viewBox="0 0 400 80" role="img" aria-label="${title}: TypeScript and Rust median and trial ranges"><title>${title}: median dots and min–max ranges in ns/op</title>${marks(a, 25, 'TypeScript', 'node')}${marks(b, 59, 'Rust', 'rust')}</svg><div class="values">${values('TypeScript', a)}${values('Rust', b)}</div><details><summary>Seven trial values</summary><div class="trials">${trialValues('TypeScript', a)}${trialValues('Rust', b)}</div></details>`;
    charts.append(card);
  }
}
select.addEventListener('change', render);
render();
</script>
</body>
</html>
'''.replace('__DATA__', payload)
    OUTPUT.write_text(html, encoding='utf-8')
    print(f'Wrote {OUTPUT}')


if __name__ == '__main__':
    main()
