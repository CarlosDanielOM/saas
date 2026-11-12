// Regenerates tests/golden/differential.json: runs the client cases against the reference server
// (the installed socket.io 4.8.3 in dimabot/node_modules, see reference-server.mjs).
//
//   node tests/js/golden.mjs [<dimabot node_modules dir>]
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [join(here, 'reference-server.mjs'), ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const [line] = await createInterface({ input: server.stdout })[Symbol.asyncIterator]().next().then((r) => [r.value]);
const ports = JSON.parse(line);
const out = join(here, '../golden/differential.json');
const cases = spawn(process.execPath, [join(here, 'client-cases.mjs'), String(ports.reference), String(ports.short), out], {
  cwd: here,
  stdio: ['ignore', 'inherit', 'inherit'],
});
const code = await new Promise((done) => cases.on('close', done));
server.stdin.end();
server.kill();
if (code !== 0) throw new Error(`client cases exited with ${code}`);
console.log(`wrote ${out}`);
