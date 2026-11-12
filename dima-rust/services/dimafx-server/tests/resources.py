#!/usr/bin/env python3
"""Loopback-only scenario/resource runner. Same harness for release Rust and installed Node.
Run from repo root: python3 dima-rust/services/dimafx-server/tests/resources.py <executable> [args...]
Node: pass an absolute dist/index.js; no install/build performed here.
RSS from /proc/<pid>/status; CPU user+system ticks from /proc/<pid>/stat, before termination.
"""
import base64
import http.client
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time

scenarios = sorted(Path('dima-rust/rig/scenarios/dimafx-server').glob('*.json'))
active = {}
calls = []

class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0)))
        calls.append((self.command, self.path, body, self.headers.get('x-dimafx-service-token')))
        response = {'json': {'error': False, 'status': 200, 'data': {'balance': '12', 'connected': False}}}
        if self.path.startswith('/dima-server:3000/'):
            routes = active.get('mock', {}).get('routes', [])
            if routes:
                response = routes[0]['respond']
        if response.get('fail') == 'drop':
            self.close_connection = True
            return
        data = json.dumps(response['json']).encode() if 'json' in response else response.get('text', '').encode()
        self.send_response(response.get('status', 200))
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    do_GET = handle_request
    do_POST = handle_request
    do_PATCH = handle_request

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
env = {**os.environ, 'PORT': str(port), 'TWITCH_EXTENSION_SECRET': 'c2VjcmV0', 'DIMAFX_SERVICE_TOKEN': 'fixture-service-token', 'DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT': 'false', 'DIMABOT_INTERNAL_API_URL': f'http://127.0.0.1:{server.server_port}/dima-server:3000', 'DIMABOT_PUBLIC_API_URL': f'http://127.0.0.1:{server.server_port}/api.domdimabot.com'}
process = subprocess.Popen(sys.argv[1:], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def sample():
    status = Path(f'/proc/{process.pid}/status').read_text()
    rss = int(next(line.split()[1] for line in status.splitlines() if line.startswith('VmRSS:')))
    stat = Path(f'/proc/{process.pid}/stat').read_text().split()
    cpu = (int(stat[13]) + int(stat[14])) / os.sysconf('SC_CLK_TCK')
    return {'rss_kib': rss, 'cpu_seconds': cpu}
def request(method, path, body=None, headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=35)
    conn.request(method, path, body=body, headers=headers or {})
    response = conn.getresponse()
    code = response.status
    response.read()
    conn.close()
    return code
try:
    for _ in range(200):
        try:
            if request('GET', '/health') == 200:
                break
        except OSError:
            if process.poll() is not None:
                raise RuntimeError('service exited before readiness')
            time.sleep(0.025)
    else:
        raise RuntimeError('readiness timeout')
    start = sample()
    steps = 0
    for path in scenarios:
        active = json.loads(path.read_text())
        for step in active['steps']:
            req = step['http']
            headers = req.get('headers', {}).copy()
            body = req.get('text')
            if 'json' in req:
                body = json.dumps(req['json']).encode()
                headers['content-type'] = 'application/json'
            code = request(req['method'], req['path'], body, headers)
            assert code == req['expect']['status'], (path.name, steps, code, req['expect'])
            steps += 1
    print(json.dumps({'scenarios': len(scenarios), 'steps': steps, 'outbound_calls': len(calls), 'start': start, 'after': sample()}))
finally:
    process.send_signal(getattr(signal, os.environ.get('DIMA_RESOURCE_SIGNAL', 'SIGTERM')))
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    assert process.returncode == 0, ("unclean shutdown", process.returncode)
    server.shutdown()
    server.server_close()
