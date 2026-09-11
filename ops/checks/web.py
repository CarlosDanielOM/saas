"""Baseline asset check. Add browser/interaction checks for the changed feature."""
from html.parser import HTMLParser
import os
import urllib.parse
import urllib.request

base = os.environ["SAAS_PREVIEW_URL"]

class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.urls.append(values["src"])
        if tag == "link" and values.get("rel") in {"stylesheet", "modulepreload"} and values.get("href"):
            self.urls.append(values["href"])

pages = ["/"]
if os.environ["SAAS_TARGET"] == "site":
    pages.append("/index.csr.html")
for page in pages:
    with urllib.request.urlopen(base + page, timeout=10) as response:
        html = response.read().decode()
        assert "<html" in html.lower()
    parser = Assets()
    parser.feed(html)
    for asset in parser.urls:
        parsed = urllib.parse.urlparse(asset)
        if parsed.scheme or parsed.netloc:
            continue
        with urllib.request.urlopen(urllib.parse.urljoin(base + page, asset), timeout=10) as response:
            assert response.status == 200
            assert "text/html" not in response.headers.get("Content-Type", ""), f"Asset fell back to HTML: {asset}"
print("Candidate HTML and local scripts/styles passed; browser/feature checks are still task-specific.")
