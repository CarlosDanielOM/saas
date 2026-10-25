"""Check the corrected MP3 guidance in HTML and text exports in both languages.

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
for prefix, accepted, stale in [
    ('', 'which is accepted', 'convert it to a listed format'),
    ('/es', 'que sí está permitido', 'conviértelo a un formato de la lista'),
]:
    for suffix in ['/', '/index.txt']:
        with urlopen(base + prefix + '/media-library' + suffix, timeout=30) as response:
            assert response.status == 200
            text = unescape(response.read().decode('utf-8'))
        assert 'audio/mpeg' in text
        assert accepted in text
        assert stale not in text
        assert 'video/quicktime' in text
print('PASS English/Spanish MP3 guidance in rendered pages and text exports')
