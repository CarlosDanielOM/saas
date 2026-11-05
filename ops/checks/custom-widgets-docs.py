"""Verify the bilingual custom widget guides: both pages per language, key sections, Overlay Studio links and llms.txt."""
import os
import urllib.parse
import urllib.request

base = os.environ["SAAS_PREVIEW_URL"]


def get(path):
    with urllib.request.urlopen(f"{base}/{path}", timeout=15) as response:
        return urllib.parse.unquote(response.read().decode())


cases = [
    ("", "Custom widgets", "Building widgets (Dima SDK)",
     ["## Import a widget", "## Write code in Studio", "**Edit code**", "## Test in Studio", "## Widget log", "## StreamElements media", "## Export for StreamElements", "**Keep loading from StreamElements**", "static.streamelements.com"],
     ["## Package files", "## Dima SDK v1", "## StreamElements compatibility", "## Limits and reliability", "## Security", "Dima.ready()", "widget.json", "widgetDuration", "namespace: string", "past 7 days"]),
    ("es/", "Widgets personalizados", "Cómo crear widgets (SDK de Dima)",
     ["## Importa un widget", "## Escribe código en Studio", "**Editar código**", "## Prueba en Studio", "## Registro del widget", "## Archivos multimedia de StreamElements", "## Exporta para StreamElements", "static.streamelements.com"],
     ["## Archivos del paquete", "## SDK de Dima v1", "## Compatibilidad con StreamElements", "## Límites y funcionamiento", "## Seguridad", "Dima.ready()", "widget.json", "widgetDuration", "namespace: string", "últimos 7 días"]),
]
for prefix, guide_title, sdk_title, guide_texts, sdk_texts in cases:
    guide = get(f"{prefix}custom-widgets/index.txt")
    sdk = get(f"{prefix}building-custom-widgets-dima-sdk/index.txt")
    assert guide_title in guide, f"{prefix}custom-widgets title"
    assert sdk_title in sdk, f"{prefix}building-custom-widgets-dima-sdk title"
    for text in guide_texts:
        assert text in guide, f"{prefix}custom-widgets missing: {text}"
    for text in sdk_texts:
        assert text in sdk, f"{prefix}building-custom-widgets-dima-sdk missing: {text}"
    for page in ("custom-widgets/", "building-custom-widgets-dima-sdk/"):
        html = get(f"{prefix}{page}")
        assert "<h1" in html and (guide_title if page.startswith("custom") else sdk_title) in html, f"{prefix}{page} renders"
    studio = get(f"{prefix}overlay-studio/")
    for page in ("custom-widgets/", "building-custom-widgets-dima-sdk/"):
        assert f'href="/{prefix}{page}"' in studio, f"{prefix}overlay-studio links {page}"
    llms = get(f"{prefix}llms.txt")
    assert f"{prefix}custom-widgets" in llms and f"{prefix}building-custom-widgets-dima-sdk" in llms, f"{prefix}llms.txt lists the guides"
print("PASS custom widget guides (EN/ES): sections, rendering, Overlay Studio links and llms.txt entries")
