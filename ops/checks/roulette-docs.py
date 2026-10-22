"""Check the published Roulette pages and their Markdown exports.

Used by: scripts/saas-ops verify docs-<run-id> --check ops/checks/roulette-docs.py
The delivery helper supplies SAAS_PREVIEW_URL for its isolated docs candidate.
"""
import os
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


BASE = os.environ["SAAS_PREVIEW_URL"].rstrip("/")
ORIGIN = "https://docs.domdimabot.com"
CACHE = {}


def fetch(path, content_type=None):
    path = urlsplit(path).path
    if path not in CACHE:
        request = Request(BASE + path, headers={"User-Agent": "DomDimaBot-roulette-docs-check/1.0"})
        with urlopen(request, timeout=30) as response:
            assert response.status == 200, path
            CACHE[path] = (response.read().decode("utf-8"), response.headers.get_content_type())
    body, received_type = CACHE[path]
    if content_type:
        assert received_type == content_type, (path, received_type)
    return body


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.text = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag in ("a", "link"):
            self.links.append(dict(attrs))

    def handle_data(self, data):
        self.text.append(data)


def normalize(value):
    return re.sub(r"\s+", " ", value).strip()


pages = {
    "en": {
        "prefix": "",
        "must_have": [
            "full-access channel admins can manage", "Last one standing", "last one standing supports 100", "slider (1–60 seconds)",
            "type up to 120 seconds", "Draw for", "Stays in", "Loses one slot",
            "Leaves the draw", "Create overlay link", "Replace overlay links",
            "saved for the channel", "streamer and authorized admins use the same link",
            "Replacing it revokes the old link", "Changing roulette settings does not invalidate the link",
            "$(roulette.add giveaways", "$(roulette.start giveaways)",
            "$(roulette.result giveaways)", "%(roulette_draw_id)",
        ],
        "index": "https://docs.domdimabot.com/roulette/index.txt",
    },
    "es": {
        "prefix": "/es",
        "must_have": [
            "administradores con acceso total pueden administrar", "Último en pie", "último en pie admite 100", "control deslizante (1–60 segundos)",
            "escribe hasta 120 segundos", "Sortear para", "Se queda",
            "Pierde un espacio", "Sale del sorteo", "Crear enlace del overlay",
            "Reemplazar enlaces del overlay", "se guarda para el canal",
            "el streamer y los administradores autorizados usan el mismo enlace",
            "se revoca el anterior", "Cambiar los ajustes de Roulette no invalida el enlace",
            "$(roulette.add giveaways", "$(roulette.start giveaways)",
            "$(roulette.result giveaways)", "%(roulette_draw_id)",
        ],
        "index": "https://docs.domdimabot.com/es/roulette/index.txt",
    },
}

for language, config in pages.items():
    prefix = config["prefix"]
    source = ORIGIN + prefix + "/roulette/"
    index_path = prefix + "/roulette/index.txt"
    html = fetch(prefix + "/roulette/", "text/html")
    parsed = Page(html)
    visible = normalize(" ".join(parsed.text))
    index = fetch(index_path, "text/plain")

    assert any(link.get("rel") == "canonical" and link.get("href") == source for link in parsed.links), source
    assert any(link.get("rel") == "alternate" and link.get("href") == config["index"] for link in parsed.links), index_path
    assert any(link.get("rel") == "describedby" and link.get("href") == ORIGIN + prefix + "/llms.txt" for link in parsed.links), index_path
    assert any(link.get("href") == index_path for link in parsed.links), f"Missing visible Markdown link: {source}"
    assert index.startswith("# Roulette Alpha\n")
    assert f"Source: {source}\n" in index
    assert f"Language: {language}\n" in index
    for expected in config["must_have"]:
        assert expected in visible, (language, "HTML", expected)
        assert expected in index, (language, "index.txt", expected)

    directory = fetch(prefix + "/llms.txt", "text/plain")
    assert f"[Roulette Alpha]({config['index']})" in directory

print("PASS: bilingual Roulette HTML and index.txt include verified modes, limits, controls, AST examples, overlay-link behavior, and discovery links.")
