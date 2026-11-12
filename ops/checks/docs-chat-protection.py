"""Check the chat-protection guidance (plan tiers, credits, exceptions) in rendered pages and text exports in both languages.

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
        "Chat protection checks each new chatter's first message on Free, first two on Premium, and first three on Pro",
        'A second or third message is read together with what that chatter wrote before.',
        'These included checks do not use AI credits on any plan.',
        'checks every message after those included checks.',
        'Asking people to follow the streamer whose chat this is does not count.',
        'The overall check must also agree that the message contains unwanted behavior before a ban.',
        'Well-known service bots such as Nightbot, StreamElements, SoundAlerts, and StreamlootsBot are skipped too.',
    ]),
    ('/es', [
        'La protección del chat revisa el primer mensaje de cada persona nueva en Free, los primeros dos en Premium y los primeros tres en Pro',
        'El segundo o tercer mensaje se lee junto con lo que esa persona escribió antes.',
        'Estas revisiones incluidas no consumen créditos de IA en ningún plan.',
        'revisa cada mensaje después de esas revisiones incluidas.',
        'Pedir que sigan al streamer dueño de este chat no cuenta.',
        'la revisión general también debe coincidir en que el mensaje contiene una conducta no deseada.',
        'También se omiten bots de servicios conocidos como Nightbot, StreamElements, SoundAlerts y StreamlootsBot.',
    ]),
]:
    for suffix in ['/', '/index.txt']:
        with urlopen(base + prefix + '/moderation' + suffix, timeout=30) as response:
            assert response.status == 200
            # The site renders typographic apostrophes; compare with plain ones.
            text = ' '.join(unescape(response.read().decode('utf-8')).split()).replace('\u2019', "'")
        for sentence in expected:
            assert sentence in text, (prefix + '/moderation' + suffix, sentence)
        # The public pages describe behavior; they do not name the classifier models.
        for model in ['Span-1', 'Jev', 'GPT-6 Luna']:
            assert model not in text, (prefix + '/moderation' + suffix, model)
print('PASS English/Spanish chat protection: included checks by plan, earlier-message context, no credits, broadcaster promotion, overall check and service bots in rendered pages and text exports')
