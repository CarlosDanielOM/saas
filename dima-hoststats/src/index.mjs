import http from 'node:http';
import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  containerView, cpuBetween, parseCpuStat, parseDf, parseDiskstats, parseLoadavg, parseMeminfo,
  parseNetDev, parsePressure, parseUptime, rate, selectContainers, statsCounters,
} from './parse.mjs';

const DEFAULT_PROJECTS = 'dimabot,dimafx,admin,dimasite,dimadocs,dimadb,databases,dima-analytics,dima-hoststats,network';

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT || 3211),
    socketPath: env.DOCKER_SOCKET || '/var/run/docker.sock',
    projects: new Set(String(env.HOSTSTATS_PROJECTS || DEFAULT_PROJECTS).split(',').map((p) => p.trim()).filter(Boolean)),
    sampleMs: Math.max(5000, Number(env.HOSTSTATS_SAMPLE_MS || 15000)),
    dfMs: Math.max(60000, Number(env.HOSTSTATS_DF_MS || 600000)),
    proc: env.HOSTSTATS_PROC || '/proc',
    // Host network namespace counters, bind-mounted read-only from the host's /proc/1/net/dev.
    netDev: env.HOSTSTATS_NET_DEV || '/host/net_dev',
    diskPath: env.HOSTSTATS_DISK_PATH || '/',
  };
}

// The only Docker API reads this service may make. Nothing here can change a container.
const ALLOWED = /^\/(version|system\/df|containers\/json\?all=1|containers\/[a-f0-9]{64}\/(json|stats\?stream=false&one-shot=true))$/;
export function dockerClient({ socketPath, timeoutMs = 5000, request = http.request }) {
  return (path, ms = timeoutMs) => new Promise((resolve, reject) => {
    if (!ALLOWED.test(path)) return reject(new Error('Docker path not allowed'));
    const req = request({ socketPath, path, method: 'GET', timeout: ms, headers: { Host: 'docker' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) req.destroy(new Error('Docker response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Docker ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function limit(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch((error) => ({ error }));
    }
  }));
  return out;
}

export function createSampler(config, { docker = dockerClient(config), read = (p) => readFile(p, 'utf8'), fsStat = statfs, now = () => Date.now() } = {}) {
  let latest = null, prevHost = null, df = null, dfRunning = false, dfAt = 0, version = null, lastAttempt = 0;
  const prevContainers = new Map();
  const optional = (path) => read(path).catch(() => null);

  async function host(at) {
    const [stat, mem, load, uptime, disks, net, pCpu, pMem, pIo] = await Promise.all([
      optional(`${config.proc}/stat`), optional(`${config.proc}/meminfo`), optional(`${config.proc}/loadavg`), optional(`${config.proc}/uptime`),
      optional(`${config.proc}/diskstats`), optional(config.netDev),
      optional(`${config.proc}/pressure/cpu`), optional(`${config.proc}/pressure/memory`), optional(`${config.proc}/pressure/io`),
    ]);
    const cpu = stat ? parseCpuStat(stat) : null;
    const io = disks ? parseDiskstats(disks) : null;
    const nic = net ? parseNetDev(net) : null;
    const seconds = prevHost ? (at - prevHost.at) / 1000 : 0;
    const usage = cpuBetween(prevHost?.cpu, cpu);
    let disk = null;
    try {
      // Inside the container "/" is overlayfs on the host's Docker disk, so this is the host disk.
      const fs = await fsStat(config.diskPath);
      const total = fs.blocks * fs.bsize;
      disk = { diskTotal: total, diskFree: fs.bavail * fs.bsize, diskUsed: total - fs.bfree * fs.bsize, inodesTotal: fs.files, inodesUsed: fs.files - fs.ffree };
    } catch { /* reported as missing */ }
    const view = {
      cpus: os.cpus().length || null,
      uptimeSec: uptime ? parseUptime(uptime) : null,
      cpuPct: usage?.cpuPct ?? null,
      iowaitPct: usage?.iowaitPct ?? null,
      stealPct: usage?.stealPct ?? null,
      ...(load ? parseLoadavg(load) : {}),
      ...(mem ? parseMeminfo(mem) : {}),
      ...(disk || {}),
      diskReadBps: rate(prevHost?.io?.read, io?.read, seconds),
      diskWriteBps: rate(prevHost?.io?.written, io?.written, seconds),
      netRxBps: rate(prevHost?.nic?.rx, nic?.rx, seconds),
      netTxBps: rate(prevHost?.nic?.tx, nic?.tx, seconds),
      netRx: nic?.rx ?? null,
      netTx: nic?.tx ?? null,
      pressure: { cpu: pCpu ? parsePressure(pCpu) : null, memory: pMem ? parsePressure(pMem) : null, io: pIo ? parsePressure(pIo) : null },
    };
    prevHost = { at, cpu, io, nic };
    return view;
  }

  async function refreshDf() {
    if (dfRunning) return;
    dfRunning = true;
    try {
      // /system/df walks every image and volume: slow, so it runs rarely and on its own.
      df = parseDf(await docker('/system/df', 120000), now());
    } catch { /* keep the previous reading */ } finally {
      dfAt = now();
      dfRunning = false;
    }
  }

  async function containers(at, errors) {
    let list;
    try {
      list = selectContainers(await docker('/containers/json?all=1'), config.projects);
    } catch (error) {
      errors.push(`docker: ${error.message}`.slice(0, 120));
      return null;
    }
    if (!version || at - version.at > 3600000) version = { at, value: (await docker('/version').catch(() => ({}))).Version || version?.value || null };
    const views = await limit(list, 4, async (entry) => {
      const inspect = await docker(`/containers/${entry.id}/json`);
      const counters = inspect.State?.Status === 'running'
        ? statsCounters(await docker(`/containers/${entry.id}/stats?stream=false&one-shot=true`).catch(() => null))
        : null;
      const view = containerView(entry, inspect, counters, prevContainers.get(entry.id), at);
      if (counters) prevContainers.set(entry.id, { at, cpuNs: counters.cpuNs, rx: counters.rx, tx: counters.tx, read: counters.read, written: counters.written });
      else prevContainers.delete(entry.id);
      if (df) {
        view.imageBytes = df.byImage[inspect.Image] ?? null;
        view.writableBytes = df.byContainer[entry.id] ?? null;
        view.volumeBytes = view.volumes.length ? view.volumes.reduce((sum, name) => sum + (df.byVolume[name] ?? 0), 0) : null;
      }
      return view;
    });
    const ids = new Set(list.map((c) => c.id));
    for (const id of prevContainers.keys()) if (!ids.has(id)) prevContainers.delete(id);
    const ok = views.filter((v) => !v.error);
    if (ok.length < views.length) errors.push(`docker: ${views.length - ok.length} container reads failed`);
    return ok.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function sample() {
    const at = now();
    lastAttempt = at;
    const errors = [];
    const [hostView, list] = await Promise.all([host(at), containers(at, errors)]);
    if (list && (!df || at - dfAt > config.dfMs)) void refreshDf();
    const { byImage, byContainer, byVolume, ...dfSummary } = df || {};
    latest = {
      version: 1,
      at: new Date(at).toISOString(),
      sampleMs: config.sampleMs,
      host: hostView,
      docker: { reachable: !!list, version: version?.value ?? null, df: df ? dfSummary : null },
      containers: list || [],
      errors,
    };
    return latest;
  }

  return { sample, latest: () => latest, lastAttempt: () => lastAttempt };
}

export function createServer(sampler, config) {
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { message: 'Read-only service' });
    if (req.url === '/health') {
      const fresh = Date.now() - sampler.lastAttempt() < config.sampleMs * 4;
      return send(fresh ? 200 : 503, { status: fresh ? 'ok' : 'stale', sampledAt: sampler.latest()?.at ?? null, dockerReachable: sampler.latest()?.docker.reachable ?? false });
    }
    if (req.url === '/v1/snapshot') {
      const latest = sampler.latest();
      return latest ? send(200, latest) : send(503, { message: 'No sample yet' });
    }
    return send(404, { message: 'Not found' });
  });
}

export async function start(config = configFromEnv()) {
  const sampler = createSampler(config);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await sampler.sample(); } catch { /* next tick retries */ } finally { busy = false; }
  };
  await tick();
  const timer = setInterval(() => void tick(), config.sampleMs);
  const server = createServer(sampler, config).listen(config.port, '0.0.0.0');
  return { server, sampler, close: () => { clearInterval(timer); server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { runtime.close(); process.exit(0); });
}
