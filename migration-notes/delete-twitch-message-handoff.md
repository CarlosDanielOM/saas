# Delete Twitch message adapter

The native `delete_message` adapter is a **verified partial local feature**.
The TypeScript source remains live. The final source-bound validation passed at
commit `df3223f28769060202a216b1c8baf68a6cdadf31`; source callers have not
adopted the native function. The adapter is not deployed, and no deployment or
push is implied.

See [`delete-twitch-message.md`](delete-twitch-message.md) for the bounded
behavior, verified outcomes and open parity gaps. The indexed package at
[`evidence/2026-10-30-delete-twitch-message/README.md`](evidence/2026-10-30-delete-twitch-message/README.md)
preserves the exact source bindings, three Node/compiler attempts, Clippy
corrections, fixtures, cleanup audit, final readback and reproduction tools.

This is partial because the reused native JSON parser has a 128-level depth
limit while JavaScript `JSON.parse` accepts the tested depth 129 and 256
payloads. The feature also has documented logger error/stack and concrete
header-error boundaries. The unrelated deep JSON parser work remains
unverified and is not credited to this feature.
