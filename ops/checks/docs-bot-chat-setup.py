#!/usr/bin/env python3
"""Docs behaviour check for the two-level streamer setup (2026-11-10).

SAAS_PREVIEW_URL=https://docs.domdimabot.com python3 ops/checks/docs-bot-chat-setup.py

Runs the general docs check (indexes, links, llms exports), then checks that the setup pages
(en + es) describe "Add bot to chat" + optional "Give full access" and no longer mention the
removed "Activate Bot" / "Turn the bot on" buttons.
"""
import os
import pathlib
import runpy
import sys
import urllib.request

BASE = os.environ['SAAS_PREVIEW_URL'].rstrip('/')
HERE = pathlib.Path(__file__).resolve().parent


def text(path: str) -> str:
    with urllib.request.urlopen(f'{BASE}{path}', timeout=20) as response:
        assert response.status == 200, (path, response.status)
        return response.read().decode('utf-8')


PAGES = {
    '/getting-started/index.txt': ['Add bot to chat', 'Allow on Twitch', 'Give full access', 'Text-to-speech command', 'Needs full access'],
    '/dashboard/index.txt': ['Get started', 'Give full access'],
    '/commands/built-in/index.txt': ['Needs full access'],
    '/es/getting-started/index.txt': ['Agregar bot al chat', 'Permitir en Twitch', 'Dar acceso completo'],
    '/es/dashboard/index.txt': ['Dar acceso completo'],
}
GONE = ['Activate Bot', 'Turn the bot on', 'Turn the bot off', 'Quick Actions', 'Activar bot', 'Encender el bot', 'Acciones Rápidas']

for path, needles in PAGES.items():
    body = text(path)
    for needle in needles:
        assert needle in body, f'{path}: missing "{needle}"'
    for old in GONE:
        assert old not in body, f'{path}: still mentions "{old}"'
for path in ['/index.txt', '/es/index.txt']:
    body = text(path)
    for old in GONE:
        assert old not in body, f'{path}: still mentions "{old}"'
print('PASS setup pages describe Add bot to chat + optional Give full access (en, es)')

# saas-ops verify runs a copy of this file, so find the general check by absolute path.
general = HERE / 'docs_llms.py'
if not general.exists():
    general = pathlib.Path('/root/saas/ops/checks/docs_llms.py')
sys.argv = [str(general)]
runpy.run_path(str(general), run_name='__main__')
