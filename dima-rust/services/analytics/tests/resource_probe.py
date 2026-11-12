#!/usr/bin/env python3
"""Linux RSS/CPU probe for an isolated rig service (PORT, DIMA_RESOURCE_SIDE required).

The rig owns stores and process-group cleanup. Results are written to
/tmp/analytics-resource-<side>.json. CPU is user+system clock ticks converted to seconds;
RSS is resident KiB, not virtual memory or peak RSS. Sampling interval: 50 ms.
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

process = subprocess.Popen(sys.argv[1:])
stopping = False
first = None
last = None
ticks_per_second = os.sysconf('SC_CLK_TCK')


def snapshot():
    with open(f'/proc/{process.pid}/stat') as source:
        fields = source.read().rsplit(')', 1)[1].split()
    with open(f'/proc/{process.pid}/status') as source:
        rss = int(next(line.split()[1] for line in source if line.startswith('VmRSS:')))
    return {
        'rss_kib': rss,
        'cpu_seconds': (int(fields[11]) + int(fields[12])) / ticks_per_second,
    }


def stop(*_):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while process.poll() is None and not stopping:
        try:
            last = snapshot()
            if first is None:
                try:
                    with urllib.request.urlopen(
                        'http://127.0.0.1:' + os.environ['PORT'] + '/health', timeout=0.1
                    ) as response:
                        if response.status == 200:
                            first = last
                except (OSError, ValueError):
                    pass
        except (OSError, StopIteration):
            pass
        time.sleep(0.05)
finally:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    output = '/tmp/analytics-resource-' + os.environ['DIMA_RESOURCE_SIDE'] + '.json'
    with open(output, 'w') as destination:
        json.dump({'start': first, 'after_workload': last}, destination)
