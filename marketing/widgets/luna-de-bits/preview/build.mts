// Builds a standalone preview page that runs the widget exactly like Studio/OBS do: the real frame document builder
// and the real Dima SDK in a sandboxed srcdoc frame, with a small host (host.html) speaking the postMessage protocol.
//   cd dimabot && node --import tsx ../marketing/widgets/luna-de-bits/preview/build.mts ../marketing/widgets/luna-de-bits /tmp/luna-preview.html
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../../../', import.meta.url);   // repository root
const at = (path: string) => new URL(path, root);
const { readPackage, resolveFieldData } = await import(at('dimabot/src/custom_widgets/format.ts').href);
const { buildFrameDocument } = await import(at('dimasite/src/app/features/overlays/widget-runtime/frame-document.ts').href);
// The SDK is inlined into frames as function source: compile it with plain esbuild like the app build does
// (tsx keeps names and adds a `__name` helper that doesn't exist inside the frame).
const { transformSync } = await import(at('dimabot/node_modules/esbuild/lib/main.js').href);
const sdkJs = transformSync(readFileSync(at('dimasite/src/app/features/overlays/widget-runtime/dima-sdk.ts'), 'utf8'), { loader: 'ts', format: 'esm', target: 'es2020' }).code;
const sdkFile = join(mkdtempSync(join(tmpdir(), 'dima-sdk-')), 'dima-sdk.mjs');
writeFileSync(sdkFile, sdkJs);
const { DIMA_SDK_SOURCE } = await import(pathToFileURL(sdkFile).href);

const [dir, out, network = 'open'] = process.argv.slice(2);
if (!dir || !out) throw new Error('usage: build.mts <widget dir> <out.html> [open|restricted]');
const read = (file: string) => readFileSync(resolve(dir, file), 'utf8');
const source = { html: read('html.txt'), css: read('css.txt'), js: read('js.txt'), fields: read('fields.txt'), data: read('data.txt'), manifest: read('widget.json') };
const summary = readPackage(source);
if (summary.issues.length) console.warn('package issues:', JSON.stringify(summary.issues));
const values = resolveFieldData(summary.fields, summary.data);
const exec = 'preview-exec-1';
const doc = buildFrameDocument(
  { widgetId: 'w1', revision: 1, engine: 'dima', uses: summary.manifest.uses, html: source.html, css: source.css, js: source.js, media: {}, network },
  values, { sdk: DIMA_SDK_SOURCE, shim: '', jquery: '' }, { exec, origin: 'https://domdimabot.com', apiOrigin: 'https://api.domdimabot.com' });
// Function replacements: the frame document contains `$` sequences that string replacements would interpret.
const page = readFileSync(new URL('./host.html', import.meta.url), 'utf8')
  .replace('__SRCDOC__', () => JSON.stringify(doc).replace(/</g, '\\u003c'))
  .replace('__FIELDS__', () => JSON.stringify(values))
  .replace('__EXEC__', () => JSON.stringify(exec));
writeFileSync(out, page);
console.log('wrote', out, (page.length / 1024).toFixed(1) + ' KB');
