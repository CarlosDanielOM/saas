"""Check the published Chat sound guide in both languages: sidebar entry, OBS setup with OBS's own labels, the settings
and their defaults, one-source advice, and the modules table row."""
import os
from urllib.request import urlopen

base = os.environ['SAAS_PREVIEW_URL'].rstrip('/')


def fetch(path):
    with urlopen(base + path, timeout=30) as response:
        assert response.status == 200, path
        return response.read().decode('utf-8')


expected = {
    '/chat-sound/': ('Control audio via OBS', 'Monitor Only (mute output)', 'Test in OBS', 'Hear it here', 'Skip bots',
                     'Shortest gap between pops', 'After a quiet chat', 'pick the existing chat sound source',
                     'You hear the pop twice', 'free on every plan', 'Allow sound'),
    '/es/chat-sound/': ('Controlar audio vía OBS', 'Solo monitorización (salida silenciada)', 'Probar en OBS', 'Escúchalo aquí',
                        'Saltar bots', 'Pausa mínima entre pops', 'Después de un chat en calma',
                        'elige la fuente del sonido del chat que ya existe', 'Escuchas el pop dos veces',
                        'gratis en todos los planes', 'Permitir sonido'),
}
for path, phrases in expected.items():
    body = fetch(path)
    for phrase in phrases:
        assert phrase in body, (path, phrase)
    assert 'vosotros' not in body and 'ordenador' not in body, (path, 'es-MX wording')
# Sidebar link and the modules table on both languages.
assert 'href="/chat-sound/"' in fetch('/tts/'), 'sidebar entry (en)'
assert 'href="/es/chat-sound/"' in fetch('/es/tts/'), 'sidebar entry (es)'
assert '/chat-sound/' in fetch('/modules/') and '/es/chat-sound/' in fetch('/es/modules/'), 'modules table rows'
print('chat sound docs check passed')
