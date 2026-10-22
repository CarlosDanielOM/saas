import test from 'node:test';
import assert from 'node:assert/strict';
import { containerView, cpuBetween, parseCpuStat, parseDf, parseDiskstats, parseMeminfo, parseNetDev, parsePressure, rate, selectContainers, statsCounters } from '../src/parse.mjs';
import { createSampler, createServer, dockerClient } from '../src/index.mjs';

const id = (c) => c.repeat(64);

test('host /proc parsers', () => {
  const a = parseCpuStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3');
  const b = parseCpuStat('cpu  200 0 100 1500 100 0 0 0 0 0');
  const usage = cpuBetween(a, b);
  assert.equal(Math.round(usage.cpuPct), 17); // 150 busy of 900
  assert.equal(Math.round(usage.iowaitPct), 6);
  const mem = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nBuffers: 10 kB\nCached: 200 kB\nSReclaimable: 20 kB\nShmem: 5 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB');
  assert.deepEqual([mem.memTotal, mem.memUsed, mem.memCache, mem.swapUsed], [1024000, 614400, 235520, 0]);
  const disks = parseDiskstats('   8       0 sda 10 0 100 0 5 0 200 0 0 0 0\n   8       1 sda1 10 0 100 0 5 0 200 0 0 0 0\n   7       0 loop0 1 0 999 0 0 0 999 0 0 0 0');
  assert.deepEqual(disks, { read: 51200, written: 102400 });
  const net = parseNetDev('h1\nh2\n    lo: 50 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0\n  eth0: 1000 1 0 0 0 0 0 0 300 1 0 0 0 0 0 0\nveth1: 9 1 0 0 0 0 0 0 9 1 0 0 0 0 0 0\nbr-x: 9 1 0 0 0 0 0 0 9 1 0 0 0 0 0 0');
  assert.deepEqual(net, { rx: 1000, tx: 300 });
  assert.equal(parsePressure('some avg10=1.92 avg60=0.52 avg300=0.15 total=1\nfull avg10=0.00'), 1.92);
  assert.equal(rate(100, 50, 10), null, 'counter reset is not a negative rate');
  assert.equal(rate(100, 300, 10), 20);
});

test('only allowlisted Compose projects are reported', () => {
  const list = [
    { Id: id('a'), Names: ['/dima-server'], Labels: { 'com.docker.compose.project': 'dimabot' } },
    { Id: id('b'), Names: ['/other-app'], Labels: { 'com.docker.compose.project': 'someone-else' } },
    { Id: id('c'), Names: ['/saas-ops-test'], Labels: {} },
  ];
  assert.deepEqual(selectContainers(list, new Set(['dimabot'])).map((c) => c.name), ['dima-server']);
});

test('container view: rates, limits, stopped state and cache-excluded memory', () => {
  const inspect = { State: { Status: 'running', StartedAt: '2026-10-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', Health: { Status: 'healthy', FailingStreak: 0 } },
    RestartCount: 2, Image: 'sha256:abc', Config: { Image: 'mongo:8', Labels: { 'com.docker.compose.service': 'mongodb' } },
    HostConfig: { Memory: 1000, NanoCpus: 2e9, PidsLimit: 64, RestartPolicy: { Name: 'unless-stopped' } }, Mounts: [{ Type: 'volume', Name: 'vol1' }, { Type: 'bind', Source: '/x' }] };
  const counters = statsCounters({ cpu_stats: { cpu_usage: { total_usage: 3e9 } }, memory_stats: { usage: 800, stats: { inactive_file: 300 } }, pids_stats: { current: 7 },
    networks: { eth0: { rx_bytes: 2000, tx_bytes: 1000 } }, blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 500 }, { op: 'write', value: 900 }] } });
  assert.equal(counters.memBytes, 500);
  const view = containerView({ name: 'mongodb', project: 'databases' }, inspect, counters, { at: 0, cpuNs: 1e9, rx: 1000, tx: 500, read: 0, written: 100 }, 10000);
  assert.equal(view.cpuPct, 20); // 2 s of CPU in 10 s = 20 % of one core
  assert.equal(view.netRxBps, 100);
  assert.equal(view.blkWriteBps, 80);
  assert.equal(view.cpuLimit, 2);
  assert.equal(view.memLimit, 1000);
  assert.equal(view.finishedAt, null);
  assert.equal(view.health, 'healthy');
  assert.deepEqual(view.volumes, ['vol1']);
  const stopped = containerView({ name: 'x', project: 'p' }, { State: { Status: 'exited', ExitCode: 137, OOMKilled: true }, HostConfig: {} }, null, null, 1);
  assert.equal(stopped.cpuPct, null);
  assert.equal(stopped.memBytes, null);
  assert.equal(stopped.oomKilled, true);
  assert.equal(stopped.memLimit, null);
});

test('df summary counts shared layers once and finds reclaimable cache', () => {
  const df = parseDf({ LayersSize: 5000, Images: [{ Id: 'i1', Size: 3000, SharedSize: 1000, Containers: 1 }, { Id: 'i2', Size: 2500, SharedSize: 1000, Containers: 0 }],
    Containers: [{ Id: id('a'), ImageID: 'i1', SizeRw: 42 }], Volumes: [{ Name: 'v', UsageData: { Size: 77 } }],
    BuildCache: [{ Size: 10, InUse: false, Shared: false }, { Size: 5, InUse: true }] }, 0);
  assert.equal(df.imagesBytes, 5000);
  assert.equal(df.imagesUnusedBytes, 1500);
  assert.equal(df.buildCacheBytes, 15);
  assert.equal(df.buildCacheReclaimable, 10);
  assert.equal(df.byContainer[id('a')], 42);
});

test('docker client refuses anything outside the read allowlist', async () => {
  const docker = dockerClient({ socketPath: '/nonexistent', request: () => { throw new Error('should not be called'); } });
  for (const path of ['/containers/abc/kill', `/containers/${id('a')}/exec`, '/containers/json', `/containers/${id('a')}/logs`, '/images/json'])
    await assert.rejects(docker(path), /not allowed/);
});

test('sampler + server end to end with a fake Docker', async () => {
  const files = { '/p/stat': 'cpu  1 0 1 10 0 0 0 0', '/p/meminfo': 'MemTotal: 100 kB\nMemAvailable: 50 kB', '/p/loadavg': '0.5 0.4 0.3 2/300 9', '/p/uptime': '123.4 9', '/net': 'a\nb\n eth0: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0' };
  const calls = [];
  const docker = async (path) => {
    calls.push(path);
    if (path === '/containers/json?all=1') return [{ Id: id('a'), Names: ['/dima-server'], Labels: { 'com.docker.compose.project': 'dimabot' } }, { Id: id('b'), Names: ['/other'], Labels: { 'com.docker.compose.project': 'nope' } }];
    if (path === '/version') return { Version: '29.0.0' };
    if (path === '/system/df') return { Images: [{ Id: 'sha256:img', Size: 9 }], Containers: [], Volumes: [], BuildCache: [] };
    if (path.endsWith('/json')) return { State: { Status: 'running' }, HostConfig: {}, Image: 'sha256:img', Config: { Labels: {} } };
    return { cpu_stats: { cpu_usage: { total_usage: 1 } }, memory_stats: { usage: 10 } };
  };
  let clock = 1000;
  const config = { proc: '/p', netDev: '/net', diskPath: '/', sampleMs: 15000, dfMs: 600000, projects: new Set(['dimabot']) };
  const sampler = createSampler(config, { docker, read: async (p) => { if (p in files) return files[p]; throw new Error('missing'); }, fsStat: async () => ({ blocks: 100, bsize: 10, bfree: 40, bavail: 30, files: 10, ffree: 4 }), now: () => clock });
  const first = await sampler.sample();
  assert.equal(first.containers.length, 1);
  assert.equal(first.docker.version, '29.0.0');
  assert.equal(first.host.diskUsed, 600);
  assert.equal(first.host.memUsed, 51200);
  assert.equal(first.host.load1, 0.5);
  assert(!calls.some((p) => p.includes(id('b'))), 'non-allowlisted container never inspected');
  await new Promise((r) => setTimeout(r, 5));
  clock += 15000;
  const second = await sampler.sample();
  assert.equal(second.docker.df.imagesBytes, 9);
  assert.equal(second.containers[0].imageBytes, 9);
  assert.equal(second.host.netRxBps, 0);
  const server = createServer(sampler, config).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const snap = await (await fetch(url + '/v1/snapshot')).json();
    assert.equal(snap.containers[0].name, 'dima-server');
    assert.equal('byImage' in snap.docker.df, false, 'internal lookup maps are not exported');
    assert.equal((await fetch(url + '/v1/snapshot', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/nope')).status, 404);
  } finally { server.close(); }
});
