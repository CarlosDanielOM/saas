# Public crawler access

The documentation publishes static HTML, `/robots.txt`, `/llms.txt`,
`/es/llms.txt`, per-language `llms-full.txt`, and an `index.txt` Markdown
alternative under every documentation page. These files regenerate on build.

## Cloudflare follow-up

Production checks on 2026-09-13 found that the public docs return HTTP 200 to
a browser, curl, and the honestly identified `DomDimaBot-docs-check/1.0` client.
The same URL with `User-Agent: Python-urllib/3.14` returns HTTP 403 and
`error code: 1010` from Cloudflare. The origin serves the page successfully.
The session's separate web extraction tool could not open the site either,
but did not expose an HTTP response, so its cause was not established.

Cloudflare documents error 1010 as a browser-signature block. Its Browser
Integrity Check can reject automated clients even when robots.txt allows them.
Publishing llms.txt does not override edge security rules.

An operator with Cloudflare access should review a **configuration rule** with
this hostname expression:

```text
(http.host eq "docs.domdimabot.com")
```

Set **Browser Integrity Check: Off** for that rule. Preserve existing rules
and check their ordering. This change should apply only to the public docs
hostname; no zone-wide security change is needed. Alternatively, Cloudflare
supports skipping Browser Integrity Check through a scoped custom rule.
This setting was **not changed** by the docs deployment.

Then retest without cookies or authentication:

```bash
curl --fail --show-error -A 'Python-urllib/3.14' \
  https://docs.domdimabot.com/llms.txt
SAAS_PREVIEW_URL=https://docs.domdimabot.com python3 ops/checks/docs_llms.py
```

Check a real assistant's web extraction tool too. If it remains blocked,
inspect Cloudflare Security Events for that request before changing another
rule. A user-agent simulation does not establish access from a real AI
provider's network, and successful crawling does not guarantee indexing.

The checked-in HTTP verifier identifies itself with
`DomDimaBot-docs-check/1.0`; its success establishes content and link integrity
for that client, not unrestricted crawler access.

References:

- [Cloudflare error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
- [Browser Integrity Check and selective exceptions](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)

## Content verification

`npm test --prefix dimadocs` checks that exports preserve every fenced example,
inline code literal, table, tab label, and card reference in the docs source.
The delivery behavior check `ops/checks/docs_llms.py` checks both language
indexes, exported pages and complete bundles, code examples, canonical and
alternate links, visible navigation, HTML tables, robots.txt, and sitemap
coverage. Use it with `scripts/saas-ops verify RUN --check` before deployment.
