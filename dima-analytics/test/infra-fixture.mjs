// Sidecar snapshot fixture, including fields the analytics service must drop.
export function fixtureSnapshot(at = new Date().toISOString()) {
  const c = (name, extra = {}) => ({ name, project: 'dimabot', service: name, image: 'saas-ops/api:api-0123', state: 'running', health: null, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: null,
    oomKilled: false, restartCount: 0, restartPolicy: 'unless-stopped', cpuPct: 12.5, cpuLimit: null, memBytes: 2.5e8, memLimit: null, pids: 20, pidsLimit: null,
    netRx: 1e9, netTx: 2e9, netRxBps: 1000, netTxBps: 2000, blkRead: 1e6, blkWrite: 2e6, blkReadBps: 10, blkWriteBps: 20, imageBytes: 1.6e9, writableBytes: 4096, volumeBytes: null, volumes: ['secret-volume-name'], ...extra });
  return { version: 1, at, sampleMs: 15000,
    host: { cpus: 16, uptimeSec: 3600, cpuPct: 26, iowaitPct: 0.1, stealPct: 0, load1: 2.7, load5: 1.6, load15: 1.4, running: 3, procs: 2200, memTotal: 32e9, memAvailable: 15e9, memUsed: 17e9,
      memFree: 2e9, memCache: 17e9, memShared: 3e9, swapTotal: 0, swapUsed: 0, diskTotal: 322e9, diskFree: 127e9, diskUsed: 181e9, inodesTotal: 2e7, inodesUsed: 5e6,
      diskReadBps: 12000, diskWriteBps: 1e6, netRxBps: 24000, netTxBps: 40000, netRx: 2e11, netTx: 8e10, pressure: { cpu: 2.3, memory: 0, io: 0.04 }, hostname: 'should-be-dropped' },
    docker: { reachable: true, version: '29.8.0', df: { at, imagesCount: 424, imagesBytes: 27.5e9, imagesUnusedBytes: 6.8e9, buildCacheBytes: 27e9, buildCacheReclaimable: 19.6e9, volumesCount: 3, volumesBytes: 8.4e8, containersBytes: 1.4e8 } },
    containers: [c('dima-server'), c('mongodb', { project: 'databases', image: 'mongo:8.2.6', health: 'healthy', memLimit: 5.3e9, cpuPct: 23 }), c('dima-cron', { state: 'exited', exitCode: 137, oomKilled: true, cpuPct: null, memBytes: null }),
      c('../evil', {}), { name: 'weird', state: 'hacked', image: 'rm -rf /', env: 'SECRET=1', cpuPct: 'NaN' }],
    errors: ['docker: fine', 42] };
}
