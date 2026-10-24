"""Verify bilingual docs for stable Redemptions: limits, pause, live status, and anchors that cross-link."""
import os
import re
import runpy
import urllib.parse
import urllib.request
from pathlib import Path

base = os.environ["SAAS_PREVIEW_URL"]


def get(path):
    with urllib.request.urlopen(f"{base}/{path}", timeout=10) as response:
        return response.read().decode()


cases = [
    ("", "Stable", "limits", "pause-rewards",
     ["Per viewer, each stream", "Per stream, everyone together", "Cooldown after each redeem", "up to 7 days",
      "Twitch only shows cooldowns of 1 minute or more"],
     ["**Pause all**", "**Resume all**", "**Sold out this stream**", "**3/10 this stream**", "Pause those on Twitch"]),
    ("es/", "Estable", "límites", "pausar-recompensas",
     ["Por espectador, en cada stream", "Por stream, entre todos", "Enfriamiento tras cada canje", "de 1 segundo a 7 días",
      "Twitch solo muestra a los espectadores enfriamientos de 1 minuto o más"],
     ["**Pausar todas**", "**Reanudar todas**", "**Agotada en este stream**", "**3/10 en este stream**", "Páusalas desde Twitch"]),
]
for prefix, stable, limits_id, pause_id, reward_texts, redemption_texts in cases:
    row = next(r for r in get(f"{prefix}modules/index.txt").splitlines() if r.startswith("|") and "/redemptions/" in r)
    assert re.search(rf"\|\s*{stable}\s*\|\s*$", row), row
    rewards = get(f"{prefix}rewards/index.txt")
    for text in reward_texts:
        assert text in rewards, f"{prefix}rewards missing: {text}"
    assert "Cooldown (seconds)" not in rewards and "Tiempo de espera (segundos)" not in rewards, "old cooldown field removed"
    redemptions = get(f"{prefix}redemptions/index.txt")
    for text in redemption_texts:
        assert text in redemptions, f"{prefix}redemptions missing: {text}"
    # Cross-links land on real headings.
    rewards_html = urllib.parse.unquote(get(f"{prefix}rewards/"))
    redemptions_html = urllib.parse.unquote(get(f"{prefix}redemptions/"))
    assert f'id="{limits_id}"' in rewards_html, f"{prefix}rewards has no #{limits_id}"
    assert f'id="{pause_id}"' in redemptions_html, f"{prefix}redemptions has no #{pause_id}"
    assert f"rewards/#{limits_id}" in redemptions_html
    assert f"redemptions/#{pause_id}" in rewards_html
runpy.run_path(str(Path.cwd() / "ops/checks/docs_llms.py"), run_name="__main__")
print("PASS bilingual docs: Redemptions stable, limits + pause documented, cross-link anchors resolve, text exports faithful")
