# Node 24 / node-re2 string codec prerequisite

**Status (2026-10-30): bounded prerequisite verified; regex execution is not implemented here.** The checked-in `re2_string.rs` provides pattern and input encoding, a checked UTF-16 prefix index, and capture decoding primitives for Node 24.22.1 / node-re2 1.27.0. It is not a complete RE2 adapter and has no application caller.

## Evidence and measured boundary

The isolated Node 24 source-built addon replayed all 1,472 recorded codec inputs and outputs, including first-byte `\C` capture/index observations. Receipt digest: `a5a92da501dfaa4e78098ee0b8a5e97367cbe7bd1d6dd5dcf0a281c2ed077f31`; private fixture binary digest: `94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb`. The fixture was compiled from 1,762 byte-identical installed SDK source files because the installed addon uses Node ABI 147, while the pinned Node 24 runtime requires ABI 137. The installed binary was left untouched. The final `--check` replay reproduced the recorded fixture byte-for-byte. Evidence package: [`evidence/2026-10-30-advanced-moderation-prerequisites/`](evidence/2026-10-30-advanced-moderation-prerequisites/).

The earlier candidate rule, lossy UTF-8 with its final scalar removed for malformed input, was falsified by 27 mismatches. The measured candidate sets available byte capacity to V8's default UTF-8 length minus the number of unpaired UTF-16 units, emits replacement bytes, and stops before a scalar would exceed that capacity. It matched every recorded `Buffer::New` output. Well-formed strings borrow existing UTF-8; patterns encode unpaired UTF-16 units as three-byte WTF-8 and valid pairs as four bytes. The checked prefix scanner follows the SDK header's width and partial-lead counting.

These observations cover the bounded receipt only. They are not proof for arbitrary malformed inputs or other Node/SDK versions. General malformed capture byte strings remain unproven. The representation supports borrowing/no-allocation on the well-formed path as a code contract; no allocation or performance benchmark was run, so no runtime-performance claim follows.

The ignored external replay uses the existing Rust SHA-256 utility; it does not require a `sha256sum` executable. It verifies the independently supplied receipt digest, runtime/source pins, encodings and lengths, and first-byte capture/index observations.

## Scope and remaining blockers

This helper supplies only string-boundary primitives. Regex compilation/execution, wrapper options and errors, capture semantics beyond the measured probe, pattern identifiers/cache behavior, `matches`, and application adapters remain outside this prerequisite. The advanced moderation migration is therefore incomplete. No deployment, caller adoption, source retirement, release build, or benchmark was performed. See the [advanced moderation prerequisite record](moderation-advanced-prerequisites.md) for the combined evidence and limits.
