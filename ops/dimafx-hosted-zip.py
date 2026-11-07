#!/usr/bin/env python3
"""Build the DimaFX zip to upload to Twitch (Extensions console -> Files -> Upload Version Assets).

Twitch hosts these files on its CDN under a strict CSP, so the script refuses to package anything that would break
there: inline <script> blocks, inline event-handler attributes, a missing or late Twitch helper, or an API base that
isn't absolute for hosted views.

Usage: python3 ops/dimafx-hosted-zip.py [--source dimafx] [--out dimafx-hosted.zip]
"""
import argparse
import hashlib
import re
import sys
import zipfile
from pathlib import Path

FILES = ["panel.html", "mobile.html", "config.html", "panel.js", "config.js", "storefront.css", "assets/logo-mark-white.png"]
HELPER = "https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"
MAX_BYTES = 1_000_000  # Twitch guideline 3.2: mobile initial load from the CDN under 1 MB.


def check(source: Path) -> list[str]:
    problems = []
    for name in FILES:
        if not (source / name).is_file():
            problems.append(f"missing {name}")
    for name in [n for n in FILES if n.endswith(".html")]:
        path = source / name
        if not path.is_file():
            continue
        html = path.read_text(encoding="utf-8")
        if re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html, re.I):
            problems.append(f"{name}: inline <script> (blocked by Twitch CSP)")
        if re.search(r"\son[a-z]+\s*=", html, re.I):
            problems.append(f"{name}: inline event-handler attribute (blocked by Twitch CSP)")
        scripts = re.findall(r"<script[^>]*\bsrc=\"([^\"]+)\"", html, re.I)
        if not scripts or scripts[0] != HELPER:
            problems.append(f"{name}: the Twitch helper must be the first script (guideline 2.9)")
    for name in [n for n in FILES if n.endswith(".js")]:
        path = source / name
        if path.is_file() and re.search(r"""\son[a-z]+=["'`]""", path.read_text(encoding="utf-8")):
            problems.append(f"{name}: renders an inline event-handler attribute")
    panel = source / "panel.js"
    if panel.is_file() and "ext-twitch\\.tv" not in panel.read_text(encoding="utf-8"):
        problems.append("panel.js: hosted views need an absolute API address (EBS_ORIGIN)")
    total = sum((source / n).stat().st_size for n in FILES if (source / n).is_file())
    if total > MAX_BYTES:
        problems.append(f"package is {total} bytes, over the 1 MB mobile budget")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", default="dimafx")
    parser.add_argument("--out", default="dimafx-hosted.zip")
    args = parser.parse_args()
    source = Path(args.source)
    problems = check(source)
    if problems:
        print("Refusing to package:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    out = Path(args.out)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))  # stable bytes for identical inputs
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, (source / name).read_bytes())
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"{out} {out.stat().st_size} bytes sha256={digest}")
    print("Files: " + ", ".join(FILES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
