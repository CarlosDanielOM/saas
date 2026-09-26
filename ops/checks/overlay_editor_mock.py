"""Check that the published site serves the overlay editor route and its interactive code."""
from html.parser import HTMLParser
from urllib.parse import urljoin
from urllib.request import urlopen
import os
import re

base = os.environ['SAAS_PREVIEW_URL']

class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.styles = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('src'):
            self.scripts.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') == 'stylesheet' and attrs.get('href'):
            self.styles.append(attrs['href'])

def fetch(path):
    with urlopen(urljoin(base + '/', path), timeout=10) as response:
        assert response.status == 200, path
        return response.read().decode('utf-8')

html = fetch('/mocks/dev/overlay-editor')
assert '<html' in html.lower()
assets = Assets()
assets.feed(html)
assert assets.scripts and assets.styles
for path in assets.scripts + assets.styles:
    fetch(path)

main = next(path for path in assets.scripts if 'main-' in path)
entry = fetch(main)
match = re.search(r'path:"overlay-editor",loadComponent:\(\)=>import\("\./([^"]+\.js)"\)', entry)
assert match, 'Overlay editor lazy route missing from published entry'
editor = fetch(match.group(1))
for feature in ('onCanvasDrop', 'onPointerMove', 'onWidgetKeydown', 'updateDimension',
                'toggleVisibility', 'duplicateSelected', 'deleteSelected', 'saveDraft',
                'resetDraft', 'saveDesign', 'toggleEvent', 'publish', 'failMedia', 'domdimabot-overlay-editor-mock-v2'):
    assert feature in editor, f'Overlay editor interaction missing: {feature}'
print('Overlay editor route, assets, and interactive draft code are present in the candidate bundle.')
