"""Check the DimaFX guide covers the playback queue, TTS items, Overlay Studio, and test trigger in both languages."""
import os
from urllib.request import urlopen

base = os.environ['SAAS_PREVIEW_URL'].rstrip('/')

checks = {
    '/dimafx/': (
        'one at a time, in purchase order',
        'Overlay Studio',
        'TTS items',
        'Test on stream',
        'resubmitting the same transaction never plays or charges twice',
    ),
    '/es/dimafx/': (
        'de uno en uno, en orden de compra',
        'Overlay Studio',
        'Elementos TTS',
        'Probar en stream',
        'reenviar la misma transacción nunca reproduce ni cobra dos veces',
    ),
}

for path, needles in checks.items():
    with urlopen(base + path, timeout=30) as response:
        assert response.status == 200, path
        body = response.read().decode('utf-8')
    for needle in needles:
        assert needle in body, (path, needle)

print('PASS docs: DimaFX queue, TTS items, Overlay Studio, and test trigger documented in EN and ES')
