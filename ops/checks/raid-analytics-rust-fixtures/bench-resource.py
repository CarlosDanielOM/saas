"""Exact exited-child CPU and peak RSS on Linux; no polling loses the final tail."""
import json
import os
import resource
import signal
import sys
import time

child = os.fork()
if child == 0:
    os.setgid(65534)
    os.setuid(65534)
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
print('raid_bench_process:' + json.dumps({'pid': child}), flush=True)

def forward(signum, _frame):
    try:
        os.kill(child, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)
started = time.monotonic()
_, status, usage = os.wait4(child, 0)
print('raid_bench_resource:' + json.dumps({
    'userCpuSeconds': usage.ru_utime,
    'systemCpuSeconds': usage.ru_stime,
    'forkExecPeakRssBytes': usage.ru_maxrss * 1024,
    'waitWallMs': (time.monotonic() - started) * 1000,
    'exitCode': os.waitstatus_to_exitcode(status),
}), flush=True)
sys.exit(0 if os.waitstatus_to_exitcode(status) == 0 else 1)
