"""Check the published TTS permission guide in both languages."""
import os
from urllib.request import urlopen

base = os.environ['SAAS_PREVIEW_URL'].rstrip('/')
for path in ('/tts/', '/es/tts/'):
    with urlopen(base + path, timeout=30) as response:
        assert response.status == 200, path
        body = response.read().decode('utf-8')
    for grant in ('tts:view', 'tts:manage', 'commands:manage', 'chat:admin'):
        assert grant in body, (path, grant)
    assert 'settings:manage' not in body, (path, 'stale TTS grant')
    with urlopen(base + path + 'index.txt', timeout=30) as response:
        assert response.status == 200, path + 'index.txt'
        text = response.read().decode('utf-8')
    for grant in ('tts:view', 'tts:manage', 'commands:manage', 'chat:admin'):
        assert grant in text, (path + 'index.txt', grant)

print('PASS docs: English and Spanish TTS grants appear in HTML and text exports')
