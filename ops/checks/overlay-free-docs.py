"""Verify published bilingual Overlay Studio entitlements and text exports."""
import os
import re
import runpy
import urllib.request
from pathlib import Path

base = os.environ["SAAS_PREVIEW_URL"]
for prefix, alpha in [("", "Alpha"), ("es/", "Alfa")]:
    with urllib.request.urlopen(f"{base}/{prefix}modules/index.txt", timeout=10) as response:
        modules = response.read().decode()
    rows = modules.splitlines()
    overlay = next(row for row in rows if row.startswith("|") and "overlay-studio" in row)
    roulette = next(row for row in rows if row.startswith("|") and "/roulette/" in row)
    assert re.search(rf"\|\s*Free\s*\|\s*{alpha}\s*\|", overlay), overlay
    assert re.search(rf"\|\s*Pro\s*\|\s*{alpha}\s*\|", roulette), roulette
    with urllib.request.urlopen(f"{base}/{prefix}overlay-studio/index.txt", timeout=10) as response:
        guide = response.read().decode()
    assert "**Free**" in guide
    assert "Alpha" in guide
    assert ("channel owner" if not prefix else "propietario del canal") in guide
    assert ("plan changes" if not prefix else "cambiar de plan") in guide
    assert not re.search(r"requires? \*\*Pro\*\*|Requiere \*\*Pro\*\*", guide)
runpy.run_path(str(Path.cwd() / "ops/checks/docs_llms.py"), run_name="__main__")
print("PASS bilingual docs: Overlay Studio Free + Alpha + owner access, Roulette Pro + Alpha, and faithful text exports")
