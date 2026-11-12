"""Check the chat-protection guidance in rendered pages and text exports in both languages.

Run from the repository root with SAAS_PREVIEW_URL set by saas-ops.
"""
import os
import runpy
from html import unescape
from pathlib import Path
from urllib.request import urlopen

# Reuse the established export/link/discovery checks before feature assertions.
runpy.run_path(str(Path.cwd() / 'ops/checks/docs_llms.py'))
base = os.environ['SAAS_PREVIEW_URL'].rstrip('/')
for prefix, expected in [
    ('', [
        'Asking people to follow the streamer whose chat this is does not count.',
        'The overall check must also agree that the message contains unwanted behavior before a ban.',
        'Well-known service bots such as Nightbot, StreamElements, SoundAlerts, and StreamlootsBot are skipped too.',
    ]),
    ('/es', [
        'Pedir que sigan al streamer dueño de este chat no cuenta.',
        'la revisión general también debe coincidir en que el mensaje contiene una conducta no deseada.',
        'También se omiten bots de servicios conocidos como Nightbot, StreamElements, SoundAlerts y StreamlootsBot.',
    ]),
]:
    for suffix in ['/', '/index.txt']:
        with urlopen(base + prefix + '/moderation' + suffix, timeout=30) as response:
            assert response.status == 200
            text = ' '.join(unescape(response.read().decode('utf-8')).split())
        for sentence in expected:
            assert sentence in text, (prefix + '/moderation' + suffix, sentence)
        # The public pages describe behavior; they do not name the classifier models.
        for model in ['Span-1', 'Jev', 'GPT-6 Luna']:
            assert model not in text, (prefix + '/moderation' + suffix, model)
print('PASS English/Spanish chat protection: broadcaster promotion, overall check and service bots in rendered pages and text exports')
