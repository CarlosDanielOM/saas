"""Verify the Twitch goals docs (en + es-MX): dashboard Goals, custom widget goal source, SDK fields; then the existing
custom widget docs check (verify takes a single --check, so it runs from here by absolute path)."""
import os
import subprocess
import sys
import urllib.parse
import urllib.request

base = os.environ["SAAS_PREVIEW_URL"]


def get(path):
    with urllib.request.urlopen(f"{base}/{path}", timeout=15) as response:
        return urllib.parse.unquote(response.read().decode())


pages = {
    "dashboard/index.txt": ["**On Twitch**", "do not use a goal slot", "**Open Stream Manager**", "**Reconnect Twitch**", "**When it's reached**",
                            "**When it ends without being reached**", "Actions on Bits and cheerer goals need Premium", "**Your goals here**"],
    "es/dashboard/index.txt": ["**En Twitch**", "no usan un espacio de meta", "**Abrir el Administrador de transmisiones**", "**Volver a conectar Twitch**",
                               "**Cuando se cumpla**", "**Cuando termine sin cumplirse**", "**Tus metas de aquí**"],
    "custom-widgets/index.txt": ["**Your Twitch goals**", "**Your goals here**", "Twitch has no money goals", "Twitch-sourced goal values do not move for test alerts"],
    "es/custom-widgets/index.txt": ["**Tus metas de Twitch**", "**Tus metas de aquí**", "Twitch no tiene metas de dinero",
                                    "Los valores de metas de Twitch no cambian con las alertas de prueba"],
    "building-custom-widgets-dima-sdk/index.txt": ["goalSource", "twitchType", "subPoints", "cheerers", "mode: 'twitch'"],
    "es/building-custom-widgets-dima-sdk/index.txt": ["goalSource", "twitchType", "subPoints", "cheerers", "mode: 'twitch'"],
}
for path, texts in pages.items():
    page = get(path)
    for text in texts:
        assert text in page, f"{path} missing: {text}"
for path in ("dashboard/", "es/dashboard/"):
    assert "<h1" in get(path), f"{path} renders"
print("PASS Twitch goals docs: dashboard Goals (On Twitch, free, actions, Premium for Bits/cheerers), widget goal source, SDK fields, en + es")
result = subprocess.run([sys.executable, "/root/saas/ops/checks/custom-widgets-docs.py"], env=os.environ, capture_output=True, text=True, timeout=120)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr[-2000:])
assert result.returncode == 0, "custom widget docs check"
print("PASS custom widget docs check")
