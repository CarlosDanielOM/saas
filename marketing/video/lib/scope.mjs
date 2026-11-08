// Every render and recorder test runs inside one systemd scope (memory/CPU cap, nice) and holds one host-wide
// kernel lock (flock), shared by every checkout. hold-lock.mjs keeps the lock until every process in the scope has
// exited (Chromium, every ffmpeg), even if the recorder itself crashes; stragglers are stopped after 5 s.
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HOLD = fileURLToPath(new URL('./hold-lock.mjs', import.meta.url));

export const HOST_LOCK = '/run/lock/domdimabot-demo-video.lock';
const BUSY = 75;

export const inScope = () => process.env.DEMO_IN_SCOPE === '1';

/** Re-run `script` with `args` inside the scope and lock; resolves with the child's exit code. */
export function relaunch(script, args, {memory = '4G', cpu = '400%', quiet = false} = {}) {
  for (const tool of ['systemd-run', 'flock']) {
    if (spawnSync(tool, ['--version'], {stdio: 'ignore'}).status !== 0) throw new Error(`${tool} is not available; refusing to run without a memory limit and the host lock`);
  }
  const child = spawn('systemd-run', ['--scope', '--quiet', '--collect', '-p', `MemoryMax=${memory}`, '-p', `CPUQuota=${cpu}`,
    'flock', '--nonblock', '--conflict-exit-code', String(BUSY), HOST_LOCK,
    process.execPath, HOLD, 'env', 'DEMO_IN_SCOPE=1', 'nice', '-n', '10', process.execPath, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args], {stdio: 'inherit'});
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  return new Promise(resolve => child.on('close', (code, signal) => {
    if (code === BUSY && !quiet) console.error('\n✖ another demo render or recorder test is running on this host; try again when it finishes');
    resolve(code ?? (signal ? 1 : 0));
  }));
}
