// Generates src/mime_table.rs from mime 1.6.0, the table Express 4 uses through `send.mime`
// (`res.type`, the charset `res.set` adds, `res.sendFile` and `express.static`).
//
//   node dima-rust/crates/web/tests/golden/mime_table.mjs [path/to/dimabot/node_modules]

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeModules = path.resolve(process.argv[2] ?? path.join(here, '../../../../../dimabot/node_modules'));
const require = createRequire(path.join(nodeModules, 'noop.js'));
const mime = require('send').mime;
// The copy of mime that send itself loads.
const version = createRequire(require.resolve('send'))('mime/package.json').version;

const entries = Object.keys(mime.types)
  .sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))))
  .map((ext) => `    (${JSON.stringify(ext)}, ${JSON.stringify(mime.types[ext])}),`);
const out = `//! Extension to media type, generated from mime ${version} by \`tests/golden/mime_table.mjs\`.
//! Do not edit by hand. Sorted by extension (bytes) for binary search.

pub(crate) static TYPES: &[(&str, &str)] = &[
${entries.join('\n')}
];
`;
writeFileSync(path.join(here, '../../src/mime_table.rs'), out);
console.log(`wrote ${entries.length} extensions (mime ${version}, default ${mime.default_type})`);
