// Compile and construct fixtures once before either measured process. Run only
// in the task-owned container. Arguments: <prepared-directory>.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const out = process.argv[2];
if (!out) throw new Error('prepared directory required');
fs.mkdirSync(out, {recursive: true});
fs.writeFileSync(path.join(out, 'package.json'), '{"type":"commonjs"}\n');
const root = path.resolve(__dirname, '../..');
const sources = [
  'src/utils/tts/normalize_tts_message.util.ts',
  'src/utils/tts/expressive_tts_tags.util.ts',
  'src/utils/tts/mod.rs',
  'src/utils/js_string.rs',
  'tests/fixtures/tts_benchmark_prepare.cjs',
  'tests/fixtures/tts_normalization_benchmark.cjs',
  'tests/tts_utilities.rs',
];
const sourceHashes = Object.fromEntries(sources.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
for (const name of ['normalize_tts_message.util', 'expressive_tts_tags.util']) {
  const source = fs.readFileSync(path.join(root, 'src/utils/tts', `${name}.ts`), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js);
}
const {normalizeTtsMessage} = require(path.resolve(out, 'normalize_tts_message.util.js'));
const baseOptions = {skipEmotes: true, stripLinks: true, normalizeWhitespace: true, maxLength: 0, emoteNames: ['Kappa']};
const definitions = [
  ['ascii', 'hello Kappa https://example.com/path '.repeat(8), 2000, 200, 0],
  ['unicode', 'Olá 😀 Kappa 世界 😀 '.repeat(8), 2000, 200, 0],
  ['large', 'large 😀 Kappa https://example.com/path '.repeat(512), 100, 10, 0],
  ['surrogate_truncation', '😀 Kappa https://example.com/path tail', 2000, 200, 1],
];
const workloads = definitions.map(([name, input, iterations, warmupIterations, maxLength]) => {
  const options = {...baseOptions, maxLength};
  const text = normalizeTtsMessage(input, options).text;
  let checksumPerOp = 0;
  for (let i = 0; i < text.length; i++) checksumPerOp = (checksumPerOp + text.charCodeAt(i)) >>> 0;
  return {name, input, options, iterations, warmupIterations, outputCodeUnits: text.length, checksumPerOp};
});
const prepared = {version: 1, sourceHashes, workloads};
fs.writeFileSync(path.join(out, 'fixtures.json'), `${JSON.stringify(prepared, null, 2)}\n`);
