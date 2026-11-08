# Fresh validation fixture

This AI-authored synthetic fixture is reserved for validation after development-only prompt selection. Do not use its cases, labels, or outcomes to select or revise prompts. The frozen file SHA-256 is `9cf6daaf72bf230f4aae050dad75685c307f2ee8c278331586243f3e7c3e11fb` (also recorded in `protocol.json` and `preflight-verification.json`). It is not task-blind to the policy domain, independently moderated ground truth, a prevalence estimate, or evidence of production safety.

## Composition

- 168 cases: 84 positive and 84 benign.
- 18 families: 12 original families with ten cases each (five per label), plus six supplemental challenge families with eight cases each (four per label).
- Original families: fake engagement, credential theft, scam offers, commercial services, product sales, channel promotion, social promotion, profanity usage, targeted insults, Unicode and domains, context invitation, and selection and repetition.
- Supplemental families: requested evidence, security codes, obfuscated evidence, invitation authority, role markup, and multilingual context.
- Languages, counted from the fixture: English 73, Spanish 25, Portuguese 18, French 14, German 12, Japanese 10, Korean 9, Arabic 7.
- Selected-category occurrences (a case may select multiple categories): spam 71, ads 62, self-promotion 36, profanity 12, insults 17. Positive expected-category occurrences: spam 35, ads 32, self-promotion 17, profanity 6, insults 8.

The language slices are sparse; several multilingual subsets are translation-shaped and do not represent independent coverage of every language or culture. These counts describe fixture composition, not language performance.

## Label and context notes

Labels apply only to selected categories. Ordinary paid sales are ads, while explicit fake-engagement sales are both spam and ads. A broadcaster invitation concerns channel sharing and does not excuse paid sales or scams. Context flags, not usernames or claims, determine broadcaster identity. The repetition example supplies explicit prior flooding and a request to stop. Requested-evidence cases include raw text when preceding context establishes a report; other examples explicitly solicit while claiming to quote. Unicode cases retain literal characters without normalized target text. Invitation wording follows the matcher-compatible form identified during review.

Lead review corrected the invitation examples at IDs 104–108, replaced exact target overlaps at IDs 72, 73, and 81 with older fixtures, clarified quotation-wrapper positives at IDs 122 and 124 as explicitly endorsed offers, and removed ambiguous scam-discussion context from positive ID 164. Preflight confirms the current fixture hash, unique exact and NFKC-normalized message targets, no exact target overlap with the original fixture, and no production mutations.

The production-source proof covers 1,008 baseline request comparisons against captured compiled production code, with zero request mismatches; the captured source hashes matched both running moderation containers. No response replay was part of this pre-inference check. This verifies baseline request parity, not prompt quality or candidate performance. See `preflight-verification.json`.

Treat all labels as synthetic expectations that still require review. Do not infer model performance before inference or claim moderation ground truth from this fixture.
