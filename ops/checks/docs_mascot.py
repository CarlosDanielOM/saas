"""Exact-candidate mascot check with a loopback SSE fixture and shared T3 browser.

saas-ops supplies SAAS_PREVIEW_URL. This check prints a review-context JSON path,
then waits for the browser driver to submit its assertions to /__finish. Use
--fixture-only for a development preview; no external APIs/models are called.
"""
import argparse
import json
import os
from pathlib import Path
import re
import runpy
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fixture-only', action='store_true')
args = parser.parse_args()


def interrupted(_signum, _frame):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, interrupted)
base = os.environ['SAAS_PREVIEW_URL'].rstrip('/')
assert urlsplit(base).hostname in ('127.0.0.1', 'localhost'), 'Use an isolated loopback candidate'

if not args.fixture_only:
    for path in ('/', '/commands/overview/', '/es/commands/overview/'):
        with urlopen(Request(base + path), timeout=30) as response:
            html = response.read().decode()
        assert '<docs-mascot' in html and '<svg' in html, (path, 'Missing real SVG mascot')
        assert 'data-docs-assistant-open' in html, (path, 'Missing accessible assistant launcher')
        assert 'data-docs-mascot-guide' in html, (path, 'Missing explicit page guide control')
        assert '<dialog id="docs-assistant-panel"' in html, path
    runpy.run_path('/root/saas/ops/checks/docs_visuals.py', run_name='__main__')

finished = threading.Event()
result = {}
calls = []


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, kind='application/json'):
        self.send_response(status)
        self.send_header('content-type', kind)
        self.send_header('access-control-allow-origin', '*')
        self.send_header('access-control-allow-headers', 'content-type,accept')
        self.send_header('access-control-allow-methods', 'GET,POST,OPTIONS')
        self.send_header('cache-control', 'no-store')
        self.end_headers()

    def do_OPTIONS(self):
        self.respond(204)

    def do_GET(self):
        if self.path == '/__axe.js':
            self.respond(200, 'application/javascript')
            self.wfile.write(Path('/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js').read_bytes())
            return
        self.respond(200)
        self.wfile.write(json.dumps({'calls': calls, 'finished': finished.is_set()}).encode())

    def do_POST(self):
        try:
            data = json.loads(self.rfile.read(int(self.headers.get('content-length', '0'))) or '{}')
            if self.path == '/__finish':
                assert data.get('base') == base, 'Browser receipt must match exact candidate URL'
                assert isinstance(data.get('checks'), list) and data['checks'], 'Include actual browser assertions'
                result.update(data)
                self.respond(200)
                self.wfile.write(b'{"recorded":true}')
                finished.set()
                return
            if self.path == '/docs-assistant/feedback':
                calls.append({'path': self.path, 'body': data})
                self.respond(200)
                self.wfile.write(b'{"error":false,"data":{"recorded":true}}')
                return
            assert self.path == '/docs-assistant/ask'
            calls.append({'path': self.path, 'body': data})
            question = data['messages'][-1]['content']
            if re.search(r'\berror\b', question, re.I):
                self.respond(503)
                self.wfile.write(b'{"error":true,"data":{"code":"busy"}}')
                return
            self.respond(200, 'text/event-stream')

            def send(event, payload):
                self.wfile.write(f'event: {event}\ndata: {json.dumps(payload)}\n\n'.encode())
                self.wfile.flush()

            send('start', {'id': f'fixture-{len(calls)}'})
            send('status', {'phase': 'thinking'})
            time.sleep(0.5 if 'stop' not in question.lower() else 3)
            send('status', {'phase': 'searching'})
            time.sleep(0.5)
            send('status', {'phase': 'testing'})
            time.sleep(0.25)
            send('text', {'delta': 'PREAMBLE that must disappear.'})
            send('reset', {})
            time.sleep(0.1)
            page = data['page']
            path = urlsplit(page['url']).path
            anchor = re.search(r'#([\w-]+)', question)
            fragment = '#' + anchor[1] if anchor else ''
            url = 'https://docs.domdimabot.com' + path + fragment
            es = page.get('lang') == 'es'
            label = 'Ver esta sección' if es else 'See this section'
            send('text', {'delta': f'**{label}**\n\n[{label}]({url})\n\n'})
            time.sleep(0.4)
            send('text', {'delta': '```text\n!cc hello Hello $(user)!\n```'})
            time.sleep(0.25)
            send('done', {'id': f'fixture-{len(calls)}', 'sources': [{'title': label, 'url': url}]})
        except (BrokenPipeError, ConnectionResetError):
            pass  # The browser deliberately stops a streaming answer.


server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='saas-docs-mascot-') as directory:
        context = {'base': base, 'api': f'http://127.0.0.1:{server.server_port}', 'fixture_only': args.fixture_only}
        path = Path(directory) / 'context.json'
        path.write_text(json.dumps(context))
        print(f'Mascot browser context: {path}', flush=True)
        print(json.dumps(context), flush=True)
        assert finished.wait(1800 if args.fixture_only else 240), 'Timed out waiting for actual T3 browser verification'
        assert result.get('passed') is True, result
        assert any(call['path'] == '/docs-assistant/ask' for call in calls), 'Exercise streamed assistant state'
        print(f'PASS: {len(result["checks"])} browser assertions; {len(calls)} fixture requests; shared T3 browser receipt matches {base}', flush=True)
finally:
    server.shutdown()
    server.server_close()
