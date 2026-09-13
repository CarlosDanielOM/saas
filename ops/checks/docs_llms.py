"""Read-only checks for a docs candidate or the public deployment.

SAAS_PREVIEW_URL=https://docs.domdimabot.com python3 ops/checks/docs_llms.py
"""
import os
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree

BASE = os.environ['SAAS_PREVIEW_URL'].rstrip('/')
ORIGIN = 'https://docs.domdimabot.com'
cache = {}


def fetch(path, kind=None):
    path = urlsplit(path).path
    if path not in cache:
        request = Request(BASE + path, headers={'User-Agent': 'DomDimaBot-docs-check/1.0'})
        with urlopen(request, timeout=30) as response:
            assert response.status == 200, path
            cache[path] = (response.read().decode('utf-8'), response.headers.get_content_type())
    body, content_type = cache[path]
    if kind:
        assert content_type == kind, (path, content_type)
    return body


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.links = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag in ('a', 'link'):
            self.links.append(dict(attrs))


def links(markdown):
    return re.findall(r'\]\((https://docs\.domdimabot\.com/[^\s)]*)\)', markdown)


all_sources = set()
for prefix, language in [('', 'en'), ('/es', 'es')]:
    index = fetch(prefix + '/llms.txt', 'text/plain')
    assert index.startswith('# DomDimaBot documentation')
    assert '## Command creation: read in this order' in index
    text_urls = [url for url in links(index) if urlsplit(url).path.endswith('/index.txt')]
    assert len(text_urls) >= 16, len(text_urls)
    assert len(set(text_urls)) == len(text_urls), 'Duplicate index entries'
    full = fetch(prefix + '/llms-full.txt', 'text/plain')
    for url in text_urls:
        path = urlsplit(url).path
        assert path.startswith('/es/') == (language == 'es'), path
        text = fetch(path, 'text/plain')
        assert text.startswith('# '), path
        assert '<!DOCTYPE' not in text and '<html' not in text, path
        assert f'Language: {language}\n' in text, path
        assert text in full, f'Missing full-text document: {path}'
        assert not re.search(r"import \{.*@astrojs|<\/?(?:Aside|TabItem|LinkCard)\b", text), path
        source = re.search(r'^Source: (https://\S+)$', text, re.M).group(1)
        all_sources.add(source)
        page = Page(fetch(source, 'text/html'))
        assert any(link.get('rel') == 'canonical' and link.get('href') == source for link in page.links), source
        assert any(link.get('rel') == 'alternate' and link.get('href') == url for link in page.links), path
        assert any(link.get('rel') == 'describedby' and link.get('href') == ORIGIN + prefix + '/llms.txt' for link in page.links), path
        assert any(link.get('href') == path for link in page.links), f'Missing visible Markdown link: {source}'
        for target in links(text):
            target_path = urlsplit(target).path
            if target_path.endswith('.txt'):
                assert fetch(target, 'text/plain').startswith('# '), target
    overview = fetch(prefix + '/commands/overview/index.txt')
    for expected in ['!cc -cd=300 -ul=tier1', '`450`', '`everyone`']:
        assert expected in overview, expected
    assert '-ul=sub ' not in overview
    syntax = fetch(prefix + '/commands/advanced/syntax/index.txt')
    greeting = 'Hello' if language == 'en' else 'Hola'
    for example in ['%(#wins *(%(#wins) + 1))', '$(say hello \\:\\))', '"' + greeting + ' ${$(user)}!"', '&p1']:
        assert example in syntax, (language, example)
    assistant = fetch(prefix + '/ai-assistants/index.txt')
    assert '!cc -cd=10 -ul=everyone hello ' in assistant
    for page_path in ['/ai-assistants/', '/commands/overview/', '/commands/advanced/syntax/']:
        assert '<table>' in fetch(prefix + page_path, 'text/html'), f'Missing rendered tables: {prefix + page_path}'

assert '**Via Chat**' in fetch('/commands/overview/index.txt')
assert '**Via Dashboard**' in fetch('/commands/overview/index.txt')
assert '**Por Chat**' in fetch('/es/commands/overview/index.txt')
assert '**Por Dashboard**' in fetch('/es/commands/overview/index.txt')
robots = fetch('/robots.txt', 'text/plain')
assert 'User-agent: *\nAllow: /' in robots
assert 'Sitemap: ' + ORIGIN + '/sitemap-index.xml' in robots
namespace = {'s': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
sitemap = ElementTree.fromstring(fetch('/sitemap-index.xml'))
locations = set()
for location in sitemap.findall('s:sitemap/s:loc', namespace):
    child = ElementTree.fromstring(fetch(location.text))
    locations.update(loc.text for loc in child.findall('s:url/s:loc', namespace))
assert all_sources <= locations, all_sources - locations
print(f'PASS: {len(all_sources)} bilingual documents; indexes, full text, code examples, tabs, discovery links, robots and sitemap ({len(cache)} URLs).')
