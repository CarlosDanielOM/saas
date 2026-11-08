// npm run demo:test — unit tests directly, then the end-to-end recorder test inside the same memory-capped
// scope and host-wide lock as a render (so it can never overlap a render or run uncapped on the production host).
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {relaunch} from '../lib/scope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const unit = ['scene', 'policy', 'mixer', 'fish', 'scope'].map(name => resolve(here, `${name}.test.mjs`));
const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', ...unit], {stdio: 'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);
process.exitCode = await relaunch(resolve(here, 'recorder.test.mjs'), []);
