"""Verify bilingual docs for shared Bits rules: Chat events rules section, Overlay Studio Bits looks, cross-link anchors."""
import os
import runpy
import urllib.parse
import urllib.request
from pathlib import Path

base = os.environ["SAAS_PREVIEW_URL"]


def get(path):
    with urllib.request.urlopen(f"{base}/{path}", timeout=10) as response:
        return response.read().decode()


cases = [
    ("", "bits-rules", "bits-looks",
     ["most specific one wins", "**Try an amount**", "up to 50 per channel", "**Save changes** only saves the default message",
      "nothing is sent to chat", "**A Bits rule doesn't fire:**"],
     ["**Give it its own look**", "**Use the default look**", "**New rule**", "**Turn alert on**", "even to published overlays"],
     ["Bits tiers and plan limits", "Message tiers", "2** on Premium"]),
    ("es/", "reglas-de-bits", "diseños-por-bits",
     ["gana la más específica", "**Prueba una cantidad**", "hasta 50 por canal", "**Guardar cambios** solo guarda el mensaje predeterminado",
      "no se envía nada al chat", "**Una regla de Bits no se activa:**"],
     ["**Darle su propio diseño**", "**Usar el diseño predeterminado**", "**Nueva regla**", "**Activar alerta**", "incluso en overlays publicados"],
     ["Niveles de Bits y límites por plan", "Niveles de mensaje", "2** en Premium"]),
]
for prefix, rules_id, looks_id, chat_texts, overlay_texts, removed in cases:
    chat = get(f"{prefix}chat-events/index.txt")
    for text in chat_texts:
        assert text in chat, f"{prefix}chat-events missing: {text}"
    for text in removed:
        assert text not in chat, f"{prefix}chat-events still has old tier text: {text}"
    overlay = get(f"{prefix}overlay-studio/index.txt")
    for text in overlay_texts:
        assert text in overlay, f"{prefix}overlay-studio missing: {text}"
    chat_html = urllib.parse.unquote(get(f"{prefix}chat-events/"))
    overlay_html = urllib.parse.unquote(get(f"{prefix}overlay-studio/"))
    assert f'id="{rules_id}"' in chat_html, f"{prefix}chat-events has no #{rules_id}"
    assert f'id="{looks_id}"' in overlay_html, f"{prefix}overlay-studio has no #{looks_id}"
    assert f"overlay-studio/#{looks_id}" in chat_html
    assert f"chat-events/#{rules_id}" in overlay_html
runpy.run_path(str(Path.cwd() / "ops/checks/docs_llms.py"), run_name="__main__")
print("PASS bilingual docs: shared Bits rules + Overlay Studio Bits looks documented, old plan tiers removed, cross-link anchors resolve, text exports faithful")
