#!/usr/bin/env python3
"""Docs behaviour check for the two-level streamer setup (2026-11-10).

SAAS_PREVIEW_URL=https://docs.domdimabot.com python3 ops/checks/docs-bot-chat-setup.py

Runs the general docs check (indexes, links, llms exports), then checks that the setup pages
(en + es) describe the dashboard's "Turn the bot on" (works without full access) + the optional
"Activate Bot", and no longer mention the short-lived navbar chat control.
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
    '/getting-started/index.txt': ['Turn the bot on', 'Allow on Twitch', 'Activate Bot', 'Needs full access', '!s'],
    '/dashboard/index.txt': ['Get started', 'Turn the bot on', 'Tap again to turn off', 'Activate Bot'],
    '/commands/built-in/index.txt': ['Needs full access'],
    '/moderation/index.txt': ['Needs full access', 'Activate Bot'],
    '/es/getting-started/index.txt': ['Encender el bot', 'Permitir en Twitch', 'Activar bot'],
    '/es/dashboard/index.txt': ['Encender el bot', 'Activar bot'],
}
# Removed today: the navbar chat control and the "Give full access" menu item.
GONE = ['Add bot to chat', 'Give full access', 'Bot in chat · Remove', 'Quick Actions', 'Agregar bot al chat', 'Dar acceso completo', 'Acciones Rápidas']

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
print('PASS setup pages describe Turn the bot on (dashboard) + optional Activate Bot (en, es)')

# saas-ops verify runs a copy of this file, so find the general check by absolute path.
general = HERE / 'docs_llms.py'
if not general.exists():
    general = pathlib.Path('/root/saas/ops/checks/docs_llms.py')
sys.argv = [str(general)]
runpy.run_path(str(general), run_name='__main__')
