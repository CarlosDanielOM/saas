// Vendors the browser client files the reference serves under /socket.io/ into ../../client-dist,
// with the Brotli form next to each (the reference compresses on the fly with
// zlib.createBrotliCompress() defaults; the crate has no Brotli encoder, so it serves these).
//
//   node tests/js/vendor-client-dist.mjs [<socket.io package dir>]
//
// The default source is the reference's installed socket.io 4.8.3 (dimabot/node_modules).
import { brotliCompressSync } from 'node:zlib';
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] ?? join(here, '../../../../../dimabot/node_modules/socket.io'));
const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
if (version !== '4.8.3') throw new Error(`expected socket.io 4.8.3, found ${version}`);
const from = join(source, 'client-dist');
const to = join(here, '../../client-dist');
for (const name of readdirSync(from).sort()) {
  copyFileSync(join(from, name), join(to, name));
  writeFileSync(join(to, `${name}.br`), brotliCompressSync(readFileSync(join(from, name))));
  console.log(name);
}
