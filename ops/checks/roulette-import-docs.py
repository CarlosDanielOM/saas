"""Verify the roulette import docs (en + es-MX) in the built docs site: list and CSV formats, preview,
all-or-nothing saving, Replace and Download CSV."""
import os
import urllib.parse
import urllib.request

base = os.environ["SAAS_PREVIEW_URL"]


def get(path):
    with urllib.request.urlopen(f"{base}/{path}", timeout=15) as response:
        return urllib.parse.unquote(response.read().decode())


pages = {
    "roulette/index.txt": ["## Import a list or CSV", "**List of names:**", "`Prize 1, Prize 1, Prize 2` adds Prize 1 with 2 slots",
                           "`name,weight,count,action`", "if anything is refused, nothing is added", "never adds the list twice",
                           "**Replace the current prizes**", "**Download CSV**", "up to 10,000 prizes"],
    "es/roulette/index.txt": ["## Importar una lista o un CSV", "**Lista de nombres:**", "`Premio 1, Premio 1, Premio 2` agrega Premio 1 con 2 espacios",
                              "`nombre,peso,cantidad,accion`", "si algo se rechaza, no se agrega nada", "nunca agrega la lista dos veces",
                              "**Reemplazar los premios actuales**", "**Descargar CSV**", "hasta 10 000 premios"],
}
for path, texts in pages.items():
    page = get(path)
    for text in texts:
        assert text in page, f"{path} missing: {text}"
for path, heading in (("roulette/", "Import a list or CSV"), ("es/roulette/", "Importar una lista o un CSV")):
    html = get(path)
    assert "<h1" in html and heading in html, f"{path} renders the import section"
print("PASS roulette import docs: list + CSV formats, preview, all-or-nothing, Replace, Download CSV, en + es")
