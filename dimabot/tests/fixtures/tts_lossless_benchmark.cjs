// Isolated prepared-operation benchmark: --write DIR, then --check DIR.
// Measures the source function plus a wrapping sum of every returned UTF-16
// unit. Setup, JSON, and I/O are outside timing. Medians are microseconds/op;
// these numbers say nothing about CPU, RSS, providers, or production behavior.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {loadSources} = require('./tts_lossless_source.cjs');
const [mode, dir, ...extra] = process.argv.slice(2);
if (!['--write', '--check'].includes(mode) || !dir || extra.length) throw Error('usage: --write DIR | --check DIR');
const {normalizer, pet, provenance, metadata} = loadSources();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const units = text => Array.from({length:text.length}, (_, i) => text.charCodeAt(i));
const fromUnits = a => { let result = ''; for (let i = 0; i < a.length; i += 4096) result += String.fromCharCode(...a.slice(i, i + 4096)); return result; };
const checksum = a => a.reduce((sum, unit) => (sum + unit) >>> 0, 0);
const base = {skipEmotes:true, stripLinks:true, normalizeWhitespace:true, maxLength:0};
const cases = [
  ['ascii', 'normalize', ' Hello  there, chat! ', [], {}, null, null, 10000],
  ['unicode', 'normalize', '¡Hola! café 世界 😀\u00a0fin', [], {}, null, null, 10000],
  ['large-utf8', 'normalize', ('Café 世界 😀 ready to speak! ').repeat(90), [], {stripLinks:false}, null, null, 1000],
  ['lone-units', 'normalize', '\ud800 A\udc00\ud801😀\udfff end', [], {stripLinks:false,maxLength:8}, null, null, 10000],
  ['emote-tokens', 'normalize', 'Kappa Kappa! \ud800 \udc00 KEKW  Kappa', [' Kappa ', '\ud800', '\udc00', 'KEKW'], {}, null, null, 10000],
  ['link-boundaries', 'normalize', 'a.com/x?y=1 test@example.org http://foo.co:88/x \ud800.org abc.x a..com', [], {}, null, null, 10000],
  ['whitespace-controls', 'normalize', '\ufeff\ttext\0\u0085\u180e  next\n\ud800', [], {normalizeWhitespace:false,stripLinks:false}, null, null, 10000],
  ['pet-fish', 'pet', '[happy] Kappa Hello a.com/\ud800 [sad] 😀', ['Kappa'], {}, 'fish', {happy:true,sad:false}, 10000],
  ['pet-piper', 'pet', '[happy] Kappa Hello a.com/\ud800 [sad] 😀', ['Kappa'], {}, 'piper', {happy:true,sad:false}, 10000],
  ['pet-large', 'pet', ('[happy] Hello 世界 😀 Kappa example.com/path ').repeat(60), ['Kappa'], {maxLength:0}, 'fish', {happy:true}, 1000],
];
function prepare() {
  const workloads = cases.map(([name, op, text, emotes, overrides, provider, tags, iterations]) => {
    const options = {...base,...overrides};
    const filters = {...options, expressiveTags:tags};
    const result = op === 'normalize' ? normalizer.normalizeTtsMessage(text, {...options,emoteNames:emotes}) : pet.filterPetTalkText(text, provider, filters, emotes);
    const expectedUnits = units(result.text);
    return {name,op,inputUnits:units(text),emoteUnits:emotes.map(units),options,provider,tags,iterations,expectedUnits,expectedUnitsChecksum:checksum(expectedUnits)};
  });
  return {schema:1,warmups:100,samples:7,measurement:'function plus wrapping UTF-16 unit sum',provenance,metadata,benchmarkSha256:sha(fs.readFileSync(__filename)),workloads};
}
function operation(w) {
  const text = fromUnits(w.inputUnits), emotes = w.emoteUnits.map(fromUnits);
  const options = {...w.options,emoteNames:emotes};
  const filters = {...w.options,expressiveTags:w.tags};
  return w.op === 'normalize' ? () => normalizer.normalizeTtsMessage(text,options).text : () => pet.filterPetTalkText(text,w.provider,filters,emotes).text;
}
function consume(run, iterations) {
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    const text = run();
    for (let j = 0; j < text.length; j++) sum = (sum + text.charCodeAt(j)) >>> 0;
  }
  return sum;
}
function checkReport(report, implementation, fixture, inputSha256) {
  if (report.implementation !== implementation || report.inputSha256 !== inputSha256 || report.warmups !== 100 || report.measurement !== fixture.measurement || !Array.isArray(report.runs) || report.runs.length !== fixture.workloads.length) throw Error(`invalid ${implementation} report header`);
  fixture.workloads.forEach((w, i) => {
    const r = report.runs[i], total = Math.imul(w.expectedUnitsChecksum,w.iterations) >>> 0;
    if (!r || r.name !== w.name || r.op !== w.op || r.provider !== w.provider || r.iterations !== w.iterations || r.expectedUnitsChecksum !== w.expectedUnitsChecksum || r.resultChecksum !== total || !Array.isArray(r.samples) || r.samples.length !== 7) throw Error(`invalid ${implementation} report for ${w.name}`);
    for (const sample of r.samples) if (!Number.isSafeInteger(sample.elapsedNs) || sample.elapsedNs <= 0 || sample.checksum !== total) throw Error(`invalid ${implementation} sample for ${w.name}`);
    const median = r.samples.map(s => s.elapsedNs).sort((a,b) => a-b)[3] / w.iterations / 1000;
    if (r.medianUsPerOp !== median) throw Error(`invalid ${implementation} median for ${w.name}`);
  });
}
const inputFile = path.join(dir,'tts-lossless-benchmark-inputs.json');
const nodeFile = path.join(dir,'tts-lossless-node-benchmark.json');
const rustFile = path.join(dir,'tts-lossless-rust-benchmark.json');
const fixture = prepare();
const generated = JSON.stringify(fixture,null,2)+'\n';
if (mode === '--write') {
  fs.mkdirSync(dir,{recursive:true});
  // Never leave a stale native report attached to a newly measured source run.
  if (fs.existsSync(rustFile) || fs.existsSync(nodeFile) || fs.existsSync(inputFile)) throw Error('benchmark destination must be empty');
  fs.writeFileSync(inputFile,generated,{flag:'wx'});
  const inputSha256 = sha(Buffer.from(generated));
  const runs = fixture.workloads.map(w => {
    const run = operation(w), actual = units(run());
    if (JSON.stringify(actual) !== JSON.stringify(w.expectedUnits) || checksum(actual) !== w.expectedUnitsChecksum) throw Error(`output mismatch for ${w.name}`);
    consume(run,100);
    const total = Math.imul(w.expectedUnitsChecksum,w.iterations) >>> 0, samples = [];
    for (let i = 0; i < 7; i++) {
      const start = process.hrtime.bigint();
      const sum = consume(run,w.iterations);
      const elapsedNs = Number(process.hrtime.bigint() - start);
      if (sum !== total || !Number.isSafeInteger(elapsedNs) || elapsedNs <= 0) throw Error(`sample mismatch for ${w.name}`);
      samples.push({elapsedNs,checksum:sum});
    }
    const medianUsPerOp = samples.map(s => s.elapsedNs).sort((a,b) => a-b)[3] / w.iterations / 1000;
    return {name:w.name,op:w.op,provider:w.provider,iterations:w.iterations,expectedUnitsChecksum:w.expectedUnitsChecksum,resultChecksum:total,samples,medianUsPerOp};
  });
  const report = {implementation:'actual-typescript',inputSha256,warmups:100,measurement:fixture.measurement,runs};
  checkReport(report,'actual-typescript',fixture,inputSha256);
  fs.writeFileSync(nodeFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  process.stdout.write(`input SHA-256: ${inputSha256}\n`);
} else {
  const bytes = fs.readFileSync(inputFile);
  if (bytes.toString('utf8') !== generated) throw Error('prepared inputs, outputs, metadata, or source provenance changed');
  const inputSha256 = sha(bytes);
  for (const [file, implementation] of [[nodeFile,'actual-typescript'],[rustFile,'native-rust']]) if (fs.existsSync(file)) checkReport(JSON.parse(fs.readFileSync(file,'utf8')),implementation,fixture,inputSha256);
  process.stdout.write(`verified input SHA-256: ${inputSha256}\n`);
}
