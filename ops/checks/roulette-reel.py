"""Feature check for the Astra "Reel" roulette concept in the built site bundle.

The mock route is client-rendered, so assert the production bundle actually ships
the reel implementation and its translations, then cover the baseline guards.
"""
import os
import re
import urllib.parse
import urllib.request

base = os.environ["SAAS_PREVIEW_URL"].rstrip("/")


def get(path):
    with urllib.request.urlopen(base + path, timeout=10) as response:
        assert response.status == 200, f"{path} -> {response.status}"
        return response.read().decode("utf-8", "replace")


def content_type(path):
    with urllib.request.urlopen(base + path, timeout=10) as response:
        return response.headers.get("Content-Type", "")


def local(path):
    parsed = urllib.parse.urlparse(path)
    if parsed.scheme or parsed.netloc:
        return None
    resolved = parsed.path or ""
    if not resolved.startswith("/"):
        resolved = "/" + resolved
    return resolved


# 1. Runtime translations for the new concept exist in both languages.
assert "reelKicker" in get("/assets/i18n/en.json"), "English reel translations missing"
assert "Carrete de premios" in get("/assets/i18n/es.json"), "Spanish reel translations missing"

# 2. Collect eager scripts plus every lazy chunk they reference.
scripts = re.findall(r'src="([^"]+\.js)"', get("/index.csr.html"))
scripts += re.findall(r'src="([^"]+\.js)"', get("/"))

blobs = {}
for script in scripts:
    path = local(script)
    if path and path not in blobs:
        blobs[path] = get(path)

chunk_names = set(re.findall(r"chunk-[A-Z0-9]+\.js", "\n".join(blobs.values())))
for name in chunk_names:
    if name in blobs:
        continue
    try:
        blobs[name] = get("/" + name)
    except Exception:
        pass

all_code = "\n".join(blobs.values())

# 3. The reel concept, marker and capacity guard shipped in the bundle.
for marker in ("reel-strip", "reel-marker", "reel-capacity-block", "reel-capacity-action"):
    assert marker in all_code, f"reel bundle marker missing: {marker}"

# 4. Baseline: every eager local script returns non-HTML 200.
for script in scripts:
    resolved = local(script)
    if resolved:
        assert "text/html" not in content_type(resolved), f"Asset fell back to HTML: {script}"

print("Astra Reel bundle and translations verified.")
