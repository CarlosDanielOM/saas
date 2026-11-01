"""Verify published screenshot guides and their machine-readable alternatives.

SAAS_PREVIEW_URL is supplied by saas-ops verify. Also usable against production.
"""
import hashlib
import os
from pathlib import Path
import re
import runpy
import struct
from html.parser import HTMLParser
from urllib.request import Request, urlopen

BASE = os.environ['SAAS_PREVIEW_URL'].rstrip('/')
ROOT = Path(os.environ.get('SAAS_DOCS_ROOT', '/root/saas/dimadocs'))
ORIGIN = 'https://docs.domdimabot.com'


def fetch(path):
    with urlopen(Request(BASE + path, headers={'User-Agent': 'DomDimaBot-docs-visuals/1.0'}), timeout=30) as response:
        assert response.status == 200, path
        return response.read(), response.headers.get_content_type()


class Images(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.images = []
        self.parent_links = []
        self.links = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            self.links.append(attrs.get('href'))
            self.parent_links.append(attrs.get('href'))
        if tag == 'img' and attrs.get('src', '').startswith('/guides/'):
            self.images.append((attrs, self.parent_links[-1] if self.parent_links else None))

    def handle_endtag(self, tag):
        if tag == 'a' and self.parent_links:
            self.parent_links.pop()


pattern = re.compile(r'!\[([^\]]+)\]\((/guides/[^)\s]+)\)')
guides = {}
assets = set()
for source in sorted((ROOT / 'src/content/docs').rglob('*.mdx')):
    expected = pattern.findall(source.read_text())
    if not expected:
        continue
    slug = str(source.relative_to(ROOT / 'src/content/docs')).removesuffix('.mdx')
    path = '/' + slug.removesuffix('/index') + '/'
    html, content_type = fetch(path)
    assert content_type == 'text/html', (path, content_type)
    page = Images(html.decode())
    assert [(attrs.get('alt'), attrs['src']) for attrs, _ in page.images] == expected, path
    for attrs, href in page.images:
        assert len(attrs['alt']) >= 15, (path, 'Describe what the screenshot shows')
        assert href == attrs['src'], (path, 'Screenshot must open at full size')
        assets.add(attrs['src'])
    exported, kind = fetch(path + 'index.txt')
    assert kind == 'text/plain', path
    text = exported.decode()
    for alt, src in expected:
        assert alt in text and ORIGIN + src in text, (path, 'Missing screenshot alt/link in text export')
    guides[slug] = len(expected)

assert len(guides) >= 20, f'Expected broad bilingual visual coverage, got {len(guides)} pages'
for slug, count in guides.items():
    counterpart = slug[3:] if slug.startswith('es/') else 'es/' + slug
    assert guides.get(counterpart) == count, (slug, 'English/Spanish screenshot counts differ')

total = 0
for src in sorted(assets):
    data, kind = fetch(src)
    assert kind in ('image/png', 'image/webp'), (src, kind)
    assert len(data) <= 900_000, (src, 'Screenshot exceeds 900 kB')
    assert hashlib.sha256(data).digest() == hashlib.sha256((ROOT / 'public' / src.lstrip('/')).read_bytes()).digest(), (src, 'Served image differs from reviewed file')
    if kind == 'image/png':
        assert data.startswith(b'\x89PNG\r\n\x1a\n'), src
        width, height = struct.unpack('>II', data[16:24])
        assert 300 <= width <= 2560 and 200 <= height <= 3000, (src, width, height)
    total += len(data)
assert total < 20_000_000, ('Screenshot payload budget exceeded', total)
print(f'PASS: {len(guides)} bilingual guide pages, {len(assets)} linked screenshots ({total:,} bytes), alt text, full-size links, exact served image bytes and text exports.')

# Preserve command examples, bilingual discovery, links and sitemap coverage.
runpy.run_path(os.environ.get('DOCS_LLMS_CHECK', '/root/saas/ops/checks/docs_llms.py'), run_name='__main__')
