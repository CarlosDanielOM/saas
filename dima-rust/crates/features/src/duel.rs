//! Duels: the model, challenges, the overlay, settlement (phrases, the winner announcement, the
//! loser's timeout) and the leaderboard. Package **P4-FEAT-GAMES** fills this module; it is empty
//! until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `duel/model.ts` (254 lines): `leaderboardStatus`, `loserLogin`, `normalizeSettings`,
//!   `winnerLogin`
//! - `duel/service.ts` (139 lines): `DuelChannel`, `acceptDuel`, `authorizeDuelOverlay`,
//!   `challengeDuel`, `configureDuel`, `declineDuel`, `duelSnapshot`, `fightStreamer`, `loadDuel`,
//!   `overlayTokenState`, `presenceKey`, `tokenHash`, `updateOverlayToken`
//! - `duel/stats.ts` (41 lines): `duelLeaderboard`
//! - `duel/completion.ts` (123 lines): `settleDuels`
//!
//! Announcements are plain posts through `dima_twitch::chat::ChatOut::send`
//! (`duel/completion.ts:80`, `:88`).
