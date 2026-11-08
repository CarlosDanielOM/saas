// Started by flock inside the render scope, so it holds the host lock. Runs the recorder, then keeps the lock until
// every other process in this scope has exited (Chromium, every ffmpeg), even if the recorder crashed.
// Stragglers get SIGTERM after 5 s and SIGKILL after 10 s. Signals never stop this guard (the recorder handles them).
import {spawn} from 'node:child_process';
import {constants} from 'node:os';
import {readFileSync} from 'node:fs';

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {});
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, {stdio: 'inherit'});
const code = await new Promise(resolve => {
  child.on('error', () => resolve(1));
  child.on('exit', (exitCode, signal) => resolve(exitCode ?? 128 + (constants.signals[signal] ?? 1)));
});
const procs = `/sys/fs/cgroup${readFileSync('/proc/self/cgroup', 'utf8').trim().split(':').pop()}/cgroup.procs`;
const others = () => {
  try { return readFileSync(procs, 'utf8').split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid && pid !== process.ppid); }
  catch { return []; }
};
for (let tick = 0; others().length; tick++) {
  if (tick === 50 || tick >= 100) for (const pid of others()) { try { process.kill(pid, tick >= 100 ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ } }
  await new Promise(resolve => setTimeout(resolve, 100));
}
process.exit(code);
