#!/usr/bin/env python3
"""Create one offline Fish alias benchmark chart from a supplied JSON manifest."""
import argparse
import json
import math
from pathlib import Path

WORKLOADS = (
    "normalize-valid", "normalize-invalid", "make-ascii", "make-unicode", "make-collisions"
)


def load_manifest(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    for key in ("title", "source_commit", "input_sha256"):
        if not isinstance(data.get(key), str) or not data[key]:
            raise ValueError(f"{key} must be a nonempty string")
    if "limits" not in data or "notes" not in data:
        raise ValueError("limits and notes must be supplied")
    series = data.get("series")
    if not isinstance(series, list) or not 3 <= len(series) <= 4:
        raise ValueError("supply three or four measured series")
    labels = set()
    for item in series:
        if not isinstance(item, dict) or not isinstance(item.get("label"), str) or not item["label"]:
            raise ValueError("each series needs a label")
        if item["label"] in labels:
            raise ValueError("series labels must be unique")
        labels.add(item["label"])
        if not isinstance(item.get("kind"), str) or not item["kind"]:
            raise ValueError("each series needs a kind")
        workloads = item.get("workloads")
        if not isinstance(workloads, list) or len(workloads) != len(WORKLOADS):
            raise ValueError("each series must contain the five workloads")
        by_name = {}
        for workload in workloads:
            name = workload.get("name") if isinstance(workload, dict) else None
            if name not in WORKLOADS or name in by_name:
                raise ValueError("unknown or repeated workload")
            samples = workload.get("samples")
            if not isinstance(samples, list) or len(samples) != 7:
                raise ValueError("each workload must have seven measured samples")
            values = [sample.get("nsPerOp") if isinstance(sample, dict) else None for sample in samples]
            median = workload.get("medianNsPerOp")
            for value in [median, *values]:
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    raise ValueError("times must be finite, nonnegative numbers")
            if median < min(values) or median > max(values):
                raise ValueError("medianNsPerOp must lie within the sample range")
            by_name[name] = {"median": median, "min": min(values), "max": max(values)}
        item["measured"] = by_name
    return data


TEMPLATE = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fish alias benchmark</title><style>
:root{color-scheme:dark light;--panel:var(--card);--text:var(--foreground);--plot-muted:var(--muted-foreground);--c0:var(--chart-1);--c1:var(--chart-2);--c2:var(--chart-3);--c3:var(--chart-4)}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--foreground);font:15px/1.5 var(--font-sans)}main{max-width:1040px;margin:auto;padding:0}h1{font-size:clamp(1.35rem,4vw,1.85rem);line-height:1.2;margin:0 0 10px}h2{font-size:1.05rem;margin:24px 0 8px}p{margin:8px 0;color:var(--plot-muted)}.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-top:16px}.label{display:block;font-weight:650;margin-bottom:6px}select{width:100%;font:inherit;color:var(--text);background:var(--secondary);border:1px solid var(--border);border-radius:8px;padding:10px}.series{margin:15px 0}.series-head{display:flex;gap:8px 16px;justify-content:space-between;align-items:baseline;flex-wrap:wrap}.series-name{font-weight:650;overflow-wrap:anywhere}.number{font-variant-numeric:tabular-nums;color:var(--plot-muted)}svg{display:block;width:100%;height:30px;overflow:visible}.range{font-size:.85rem;color:var(--plot-muted);font-variant-numeric:tabular-nums}.scale{display:flex;justify-content:space-between;font-size:.8rem;color:var(--plot-muted)}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:680px;font-size:.85rem}th,td{border-bottom:1px solid var(--border);padding:10px 8px;text-align:left;vertical-align:top}th{color:var(--plot-muted);font-weight:600}td:not(:first-child){font-variant-numeric:tabular-nums}td span{display:block;color:var(--plot-muted);font-size:.8rem}footer{color:var(--plot-muted);font-size:.8rem;overflow-wrap:anywhere;margin-top:20px}.note{font-size:.88rem}.dot{display:inline-block;width:.65em;height:.65em;border-radius:50%;margin-right:.45em;background:var(--color)}
</style></head><body><main><p>Prepared Fish alias helpers · lower time is faster. Bars show medians; whiskers show the full range of seven samples.</p>
<section class="panel" aria-labelledby="plot-title"><h2 id="plot-title">Workload</h2><label class="label" for="workload">Select a workload</label><select id="workload"></select><p id="workload-note" class="note"></p><div id="plot" aria-live="polite"></div><div class="scale"><span>0 ns</span><span id="maximum"></span></div></section>
<section class="panel" aria-labelledby="table-title"><h2 id="table-title">All workloads</h2><p>Each cell shows median, then the minimum–maximum range, in nanoseconds per operation.</p><div class="table-wrap"><table><thead id="table-head"></thead><tbody id="table-body"></tbody></table></div></section>
<section class="panel note"><h2>Scope and measurement</h2><p>Synthetic prepared helper calls; 32 cases per workload, 20 full warmup passes and seven trials. Outputs were prevalidated in full; timed operations use a constant-time scalar output checksum.</p><p>The invalid case compares a JavaScript throw and stack with a native Result. These timings describe the listed helper workloads; they do not establish overall application performance or RSS. Original slower baseline measurements are retained.</p><p id="limits"></p><p id="notes"></p></section>
<footer><div id="commit"></div><div id="sha"></div></footer></main>
<script>
'use strict';
const manifest=__DATA__;
const names={'normalize-valid':'Normalize valid alias','normalize-invalid':'Normalize invalid alias','make-ascii':'Make ASCII alias','make-unicode':'Make Unicode alias','make-collisions':'Make alias with collisions'};
const order=['normalize-valid','normalize-invalid','make-ascii','make-unicode','make-collisions'];
const colors=['var(--c0)','var(--c1)','var(--c2)','var(--c3)'];
const fmt=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:3}).format(n);
const describe=v=>typeof v==='string'?v:JSON.stringify(v);
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};

document.getElementById('limits').textContent='Limits: '+describe(manifest.limits);
document.getElementById('notes').textContent='Notes: '+describe(manifest.notes);
document.getElementById('commit').textContent='Local source commit: '+manifest.source_commit;
document.getElementById('sha').textContent='Input SHA-256: '+manifest.input_sha256;
const select=document.getElementById('workload');
for(const name of order){const option=el('option',names[name]);option.value=name;select.append(option)}
select.value='make-collisions';
const header=el('tr');header.append(el('th','Workload'));manifest.series.forEach((s,i)=>{const th=el('th');const dot=el('span');dot.className='dot';dot.style.setProperty('--color',colors[i]);th.append(dot,document.createTextNode(s.label));header.append(th)});document.getElementById('table-head').append(header);
const tbody=document.getElementById('table-body');
for(const name of order){const row=el('tr');row.append(el('th',names[name]));for(const s of manifest.series){const v=s.measured[name],cell=el('td',fmt(v.median));cell.append(el('span',fmt(v.min)+'–'+fmt(v.max)));row.append(cell)}tbody.append(row)}
const ns='http://www.w3.org/2000/svg';
function svgEl(tag,attrs){const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));return n}
function draw(){
 const plot=document.getElementById('plot');plot.replaceChildren();const name=select.value;
 document.getElementById('workload-note').textContent=name==='normalize-invalid'?'Error path: JavaScript throw and stack capture versus native Result; this includes different platform error costs.':'';
 const values=manifest.series.map(s=>s.measured[name]);const max=Math.max(...values.map(v=>v.max));const denominator=max||1;
 document.getElementById('maximum').textContent=fmt(max)+' ns';
 values.forEach((v,i)=>{
  const box=el('div');box.className='series';const head=el('div');head.className='series-head';
  const label=el('div',manifest.series[i].label);label.className='series-name';const dot=el('span');dot.className='dot';dot.style.setProperty('--color',colors[i]);label.prepend(dot);
  const median=el('div',fmt(v.median)+' ns median');median.className='number';head.append(label,median);
  const svg=svgEl('svg',{viewBox:'0 0 1000 30',preserveAspectRatio:'none',role:'img','aria-label':manifest.series[i].label+': median '+fmt(v.median)+' ns, range '+fmt(v.min)+' to '+fmt(v.max)+' ns'});
  const x=n=>5+(n/denominator)*990;svg.append(svgEl('rect',{x:5,y:7,width:Math.max(0,x(v.median)-5),height:16,rx:3,fill:colors[i]}));
  svg.append(svgEl('line',{x1:x(v.min),y1:15,x2:x(v.max),y2:15,stroke:'var(--foreground)','stroke-width':2,'vector-effect':'non-scaling-stroke'}));
  for(const value of [v.min,v.max])svg.append(svgEl('line',{x1:x(value),y1:8,x2:x(value),y2:22,stroke:'var(--foreground)','stroke-width':2,'vector-effect':'non-scaling-stroke'}));
  const range=el('div','Range '+fmt(v.min)+'–'+fmt(v.max)+' ns');range.className='range';box.append(head,svg,range);plot.append(box);
 });
}
select.addEventListener('change',draw);draw();
</script></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", help="external JSON manifest")
    parser.add_argument("--output", required=True, help="new HTML file to create")
    args = parser.parse_args()
    data = load_manifest(args.manifest)
    encoded = json.dumps(data, ensure_ascii=True, allow_nan=False, separators=(",", ":")).replace("<", "\\u003c")
    html = TEMPLATE.replace("__DATA__", encoded)
    with Path(args.output).open("x", encoding="utf-8") as output:
        output.write(html)
    print(args.output)


if __name__ == "__main__":
    main()
