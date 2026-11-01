# Docs assistant API check

Run from the production checkout with a built `api` candidate:

```sh
scripts/saas-ops verify <api-run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/docs-assistant-fixtures/test-env.json \
  --fixtures ops/checks/docs-assistant-fixtures \
  --check ops/checks/docs-assistant-api.mjs
```

`providers.mjs` fakes MiniMax's streaming API (`minimax.test`) and the docs export
(`docs.test`) and blocks every other outbound request. The check runs the client and
docs-assistant unit suites in the exact image, then exercises the running API: the
streamed event order, sources, the exact MiniMax request (M3.1-Flash, `xhigh`, model
ceiling `max_tokens`, byte-stable system prompt, page note), Spanish docs, the usage
record and feedback, input validation, the CORS allowlist, upstream failure, keep-alive
pings during long thinking, client disconnect aborting upstream, per-IP and daily
limits, the simultaneous-answer cap, and the tool loop (a catalog search plus a safe command
test in one turn, results returned to the model, no Twitch calls). The unit step also runs the
whole AST engine suite, the command tester, and the catalog warm-up/cache tests.

The check does not judge answer quality. That needs real MiniMax calls (about $0.008
per question): run the candidate image with only `docsAssistantRoute` mounted, a
disposable Dragonfly, and the key passed through a temporary env file, then delete it.
