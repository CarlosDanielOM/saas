"""Check the published TTS guide explains where TTS plays (one copy / every copy, moving failed messages) in both languages."""
import os
from urllib.request import urlopen

base = os.environ['SAAS_PREVIEW_URL'].rstrip('/')


def fetch(path):
    with urlopen(base + path, timeout=30) as response:
        assert response.status == 200, path
        return response.read().decode('utf-8')


expected = {
    '/tts/': ('Play on every open copy', 'Open in N places', 'the same message moves to the next copy', 'Up to three copies',
              'is never replayed after it starts playing', 'refresh the browser source in OBS once'),
    '/es/tts/': ('Sonar en todas las copias abiertas', 'el mismo mensaje pasa a la siguiente copia', 'Hasta tres copias',
                 'nunca se vuelve a reproducir después de que comienza a sonar', 'actualiza una vez la fuente de navegador en OBS'),
}
for path, phrases in expected.items():
    for page in (path, path + 'index.txt'):
        body = fetch(page)
        for phrase in phrases:
            assert phrase in body, (page, phrase)
        # The old rule ("an interrupted message is never replayed") no longer holds before playback starts.
        assert 'interrupted by a disconnect is not replayed' not in body, (page, 'stale replay rule')
        assert 'interrumpido por una desconexión no se vuelve a reproducir' not in body, (page, 'stale replay rule')
        for grant in ('tts:view', 'tts:manage'):
            assert grant in body, (page, grant)

for prefix, phrase in (('', 'Play on every open copy'), ('/es', 'Sonar en todas las copias abiertas')):
    assert phrase in fetch(prefix + '/llms-full.txt'), (prefix + '/llms-full.txt', phrase)

print('PASS docs: TTS output selection, every-copy setting and recovery rules in English and Spanish HTML, text exports and llms-full.txt')
