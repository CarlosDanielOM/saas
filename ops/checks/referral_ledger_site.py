"""Check that the candidate site serves the referral ledger UI and translations."""
import json
import os
import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.request import urlopen

base = os.environ["SAAS_PREVIEW_URL"]
assert os.environ["SAAS_TARGET"] == "site"


def read(path):
    with urlopen(urljoin(base, path), timeout=10) as response:
        assert response.status == 200, path
        return response.read().decode()


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("src"):
            self.urls.append(attrs["src"])
        if tag == "link" and attrs.get("rel") in {"stylesheet", "modulepreload"} and attrs.get("href"):
            self.urls.append(attrs["href"])


html = read("/index.csr.html")
assert "<html" in html.lower()
assets = Assets()
assets.feed(html)
queue = list(assets.urls)
seen = set()
scripts = []
while queue:
    path = queue.pop()
    if path in seen or urlparse(path).scheme:
        continue
    seen.add(path)
    content = read(path)
    if path.endswith(".js"):
        scripts.append(content)
        for imported in re.findall(r'(?:from\s*|import\s*\(?)\s*["\'](\./[^"\']+\.js)["\']', content):
            queue.append(urljoin(path, imported))

bundle = "\n".join(scripts)
assert "referrals.ledger.peopleTab" in bundle
assert "referrals.ledger.timelineTab" in bundle
assert "/referrals/ledger" in bundle
for language in ("en", "es"):
    messages = json.loads(read(f"/assets/i18n/{language}.json"))
    ledger = messages["referrals"]["ledger"]
    assert all(ledger[key] for key in ("peopleTab", "timelineTab", "signedUp", "currentTier", "creditsEarned"))
print(f"Referral ledger UI/API client and en/es labels passed across {len(scripts)} candidate scripts")
