"""Check the DimaFX guide covers current setup, playback, TTS, Bits availability, and queue behavior in both languages."""
import os
from urllib.request import urlopen

base = os.environ['SAAS_PREVIEW_URL'].rstrip('/')

checks = {
    '/dimafx/': (
        'one at a time, in activation order',
        'Overlay Studio',
        'TTS items',
        'Test on stream',
        'Set up DimaFX on DomDimaBot',
        'Bits amount',
        'the panel says Bits are off',
        'Playing now',
        'receives channel credits equal to the Bits amount',
        '10 seconds per channel',
    ),
    '/es/dimafx/': (
        'uno a la vez, en orden de activación',
        'Overlay Studio',
        'Artículos TTS',
        'Probar en stream',
        'Configurar DimaFX en DomDimaBot',
        'Cantidad de Bits',
        'el panel indica que Bits están desactivados',
        'Reproduciendo ahora',
        'recibe créditos del canal por la misma cantidad de Bits',
        'cada 10 segundos por canal',
    ),
}

for path, needles in checks.items():
    with urlopen(base + path, timeout=30) as response:
        assert response.status == 200, path
        body = response.read().decode('utf-8')
    for needle in needles:
        assert needle in body, (path, needle)

print('PASS docs: DimaFX setup, queue, TTS, Bits availability, and playback behavior documented in EN and ES')
