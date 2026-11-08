// Production-host safety: enough free memory and no Angular/site build running (one-at-a-time is scope.mjs's flock).
import {readFileSync, readdirSync} from 'node:fs';

export function memAvailableGiB() {
  const line = readFileSync('/proc/meminfo', 'utf8').split('\n').find(l => l.startsWith('MemAvailable:'));
  return Number(line?.match(/(\d+)/)?.[1] ?? 0) / 1024 / 1024;
}

/** Our own process and its parents (the shell that started us may mention "ng build" in its text). */
function ancestors() {
  const pids = new Set();
  let pid = process.pid;
  while (pid > 1 && !pids.has(pid)) {
    pids.add(pid);
    try { pid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]); } catch { break; }
  }
  return pids;
}

/** Angular builds/dev servers and saas-ops site work in progress (they have OOM'd this host before). */
export function busyBuilds() {
  const busy = [], skip = ancestors();
  for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    if (skip.has(Number(pid))) continue;
    let args;
    try { args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    const at = name => args.findIndex(a => a === name || a.endsWith('/' + name));
    const ng = Math.max(at('ng'), at('ng.js'));
    const ops = Math.max(at('saas_ops.py'), at('saas-ops'));
    if ((ng >= 0 && /^(build|serve|b|s)$/.test(args[ng + 1] ?? '')) || (ops >= 0 && /^(build|preview)$/.test(args[ops + 1] ?? ''))) {
      busy.push(`${pid}: ${args.join(' ').slice(0, 120)}`);
    }
  }
  return busy;
}
