"""Verify that the built marketing site exposes documentation without JavaScript."""

from html.parser import HTMLParser
import os
import urllib.request


BASE_URL = os.environ["SAAS_PREVIEW_URL"].rstrip("/")
DOC_LINKS = {
    "https://docs.domdimabot.com/": "Docs",
    "https://docs.domdimabot.com/getting-started/": "Getting started",
    "https://docs.domdimabot.com/commands/": "Commands",
    "https://docs.domdimabot.com/commands/advanced/": "Advanced commands",
    "https://docs.domdimabot.com/tts/": "TTS",
}

FEATURE_LINKS = {
    "https://docs.domdimabot.com/follow-defense/": "Follow Defense guide →",
    "https://docs.domdimabot.com/commands/": "Commands guide →",
    "https://docs.domdimabot.com/dashboard/": "Dashboard guide →",
    "https://docs.domdimabot.com/tts/": "TTS guide →",
}


class Anchors(HTMLParser):
    def __init__(self):
        super().__init__()
        self.current_href = None
        self.current_text = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.current_href = dict(attrs).get("href")
            self.current_text = []

    def handle_data(self, data):
        if self.current_href is not None:
            self.current_text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.current_href is not None:
            self.links.append((self.current_href, "".join(self.current_text).strip()))
            self.current_href = None
            self.current_text = []


def get(path):
    with urllib.request.urlopen(BASE_URL + path, timeout=10) as response:
        assert response.status == 200, f"{path} returned {response.status}"
        return response.read().decode("utf-8")


landing_html = get("/")
anchors = Anchors()
anchors.feed(landing_html)

for href, label in DOC_LINKS.items():
    assert (href, label) in anchors.links, f"Missing static link: {label} -> {href}"

feature_texts = {}
for href, text in anchors.links:
    feature_texts.setdefault(href, []).append(text)

for href, label in FEATURE_LINKS.items():
    assert any(label in text for text in feature_texts.get(href, [])), (
        f"Missing feature docs link: {label} -> {href}"
    )

assert "Twitch chatbot." in landing_html, "Expected prerendered H1 to name the product type"
assert "Proof first." not in landing_html, "Old brand-only H1 leaked into prerendered HTML"

assert anchors.links.count(("https://docs.domdimabot.com/", "Docs")) >= 2, (
    "Expected quiet header and footer links to docs home"
)

robots = get("/robots.txt")
assert "Sitemap: https://docs.domdimabot.com/sitemap-index.xml" in robots

llms = get("/llms.txt")
assert "DomDimaBot is a Twitch chatbot" in llms
for href in DOC_LINKS:
    assert href in llms, f"Missing {href} from llms.txt"

print("Static docs links, docs sitemap discovery, and llms.txt passed.")
