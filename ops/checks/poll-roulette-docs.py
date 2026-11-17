"""Verify the poll / prediction / roulette function docs (en + es-MX) in the built docs site:
read functions, roulette create / delete / clear / fill, the Poll ended and Prediction ended chat
events, and the tie-breaker recipes with the exact, engine-tested examples."""
import os
import urllib.parse
import urllib.request

base = os.environ["SAAS_PREVIEW_URL"]


def get(path):
    with urllib.request.urlopen(f"{base}/{path}", timeout=15) as response:
        return urllib.parse.unquote(response.read().decode())


TIE = '*($(poll.tied) ? "${$(roulette.fill polls $(poll.tied))}${$(roulette.start polls)}Tie! The wheel decides." : "${$(poll.result)} won the poll!")'
TIE_TIMER = '${$(timer 8 The wheel picked $(roulette.result polls)!)}'
NO_VOTES = '*($(poll.total) == 0 ? "Nobody voted." : *($(poll.tied) ?'
WEIGHTED = '$(roulette.clear polls)*(for #o in $(poll.options) { %(ids[] $(roulette.add polls #o 1 $(poll.votes #o))) })$(roulette.start polls)'
DEFAULT = '*($(poll.tied) ? "The poll ended in a tie!" : "${$(poll.result)} won the poll!")'
FUNCTIONS = ["$(poll.title)", "$(poll.status)", "$(poll.options)", "$(poll.values)", "$(poll.votes option)", "$(poll.total)", "$(poll.result)", "$(poll.tied)",
             "$(prediction.title)", "$(prediction.status)", "$(prediction.options)", "$(prediction.values)", "$(prediction.points option)",
             "$(prediction.users option)", "$(prediction.total)", "$(prediction.result)",
             '$(roulette.create roulette_id ["Name"])', "$(roulette.delete roulette_id)", "$(roulette.clear roulette_id)", "$(roulette.fill roulette_id list)",
             "Error: roulette.create: Roulette with that name already exists"]

pages = {
    "commands/advanced/functions/index.txt": FUNCTIONS + ["**Reading a poll**", "**Reading a prediction**", "the Poll ended chat event does not run",
        "refused while any roulette on the channel is spinning", "Limit commands that delete or empty a roulette to moderators or the streamer"],
    "es/commands/advanced/functions/index.txt": FUNCTIONS + ["**Leer una encuesta**", "**Leer una predicción**",
        "se rechazan mientras cualquier ruleta del canal está girando", "un espacio de peso `1` por entrada"],
    "commands/advanced/recipes/index.txt": ["## Poll results", "### Break a tie with the wheel", '$(roulette.create polls "Poll tie-breaker")', TIE, TIE_TIMER,
        NO_VOTES, WEIGHTED, "### Say who is ahead"],
    "es/commands/advanced/recipes/index.txt": ["## Resultados de encuestas", "### Desempatar con la ruleta", '$(roulette.create polls "Poll tie-breaker")', TIE, TIE_TIMER,
        NO_VOTES, WEIGHTED, "### Consultar quién va adelante"],
    "chat-events/index.txt": ["## Poll and prediction ended", "**Poll ended**", "**Prediction ended**", DEFAULT, "$(prediction.result) won the prediction!",
        "only turns it off: its message is kept", "These subscriptions are not on by default"],
    "es/chat-events/index.txt": ["## Fin de encuesta y predicción", "**Fin de la encuesta**", "**Fin de la predicción**", DEFAULT, "$(prediction.result) won the prediction!",
        "solo se apaga: su mensaje se conserva", "Estas suscripciones no están activadas por defecto"],
    "roulette/index.txt": ["## Break a poll tie", "`roulette.create`, `roulette.delete`, `roulette.clear`, `roulette.fill`", "lists each function with this roulette's alias and a copy button", "`create` and `delete` are under **Create or delete a roulette**"],
    "es/roulette/index.txt": ["## Desempatar una encuesta", "`roulette.create`, `roulette.delete`, `roulette.clear`, `roulette.fill`", "muestra cada función con el alias de esta ruleta", "`create` y `delete` están en **Crear o eliminar una ruleta**"],
}
for path, texts in pages.items():
    page = get(path)
    for text in texts:
        assert text in page, f"{path} missing: {text}"
    # Nothing left over from the first draft: deleting keeps the message.
    for stale in ("clears its message", "se borra su mensaje"):
        assert stale not in page, f"{path} still says: {stale}"

# The rendered pages carry the sections and the anchors the pages link to each other with.
for path, heading, anchor in (
    ("chat-events/", "Poll and prediction ended", 'id="poll-and-prediction-ended"'),
    ("es/chat-events/", "Fin de encuesta y predicción", 'id="fin-de-encuesta-y-predicción"'),
    ("commands/advanced/recipes/", "Break a tie with the wheel", 'id="poll-results"'),
    ("es/commands/advanced/recipes/", "Desempatar con la ruleta", 'id="resultados-de-encuestas"'),
    ("commands/advanced/functions/", "Reading a poll", 'id="roulette-functions"'),
    ("es/commands/advanced/functions/", "Leer una encuesta", 'id="funciones-de-ruleta"'),
    ("roulette/", "Break a poll tie", 'id="break-a-poll-tie"'),
    ("es/roulette/", "Desempatar una encuesta", 'id="desempatar-una-encuesta"'),
):
    html = get(path)
    assert "<h1" in html and heading in html, f"{path} renders {heading}"
    assert anchor in html, f"{path} has anchor {anchor}"
print("PASS poll/roulette docs: read functions, roulette create/delete/clear/fill, Poll ended + Prediction ended, tie-breaker recipes, en + es")
