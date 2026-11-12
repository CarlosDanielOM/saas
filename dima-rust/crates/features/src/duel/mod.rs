//! Duels: settings and rules, challenges, the fight decided at accept time, the overlay
//! snapshot, the completion loop (narration, winner announcement, the loser's timeout with the
//! moderator restore), and the leaderboard. Package **P4-FEAT-GAMES**.
//!
//! TypeScript it ports (baseline `0c71108e`):
//!
//! - `duel/model.ts` (254 lines) → [`model`]: `normalizeSettings` ([`DuelSettings::normalize`]),
//!   `settings`, `rules`, `simulateBattle`, `createRun`, `winnerMessage`, `winnerLogin`,
//!   `loserLogin`, `leaderboardStatus` ([`DuelSettings::leaderboard_status`]).
//! - `duel/service.ts` (139 lines) → [`service`]: `DuelChannel` (the model crate's
//!   `duel_widgets`), `loadDuel`, `duelSnapshot`, `configureDuel`, `challengeDuel`,
//!   `fightStreamer`, `acceptDuel`, `declineDuel`, `authorizeDuelOverlay`, `presenceKey`,
//!   `tokenHash`, and the overlay token store's `read`/`save` (`manageOverlayToken` is
//!   P4-FEAT-OVERLAYS's).
//! - `duel/stats.ts` (41 lines) → [`stats`]: `recordDuelResult`, `headToHead`,
//!   `duelLeaderboard`.
//! - `duel/completion.ts` (123 lines) → [`completion`]: `settleDuels` ([`DuelCompletion::tick`]).
//!
//! Callers: the `!duel` command (P4-CHAT-CMDS-B: challenge, accept, decline, fight_streamer,
//! load), the duel widget route (P4-API-OVERLAYS: configure, snapshot, token, leaderboard), the
//! overlay socket (P4-RT-SOCKETS: authorize_overlay, version, snapshot, leaderboard, the
//! presence it writes and [`OverlayPresence`] reads), the widget feed (P4-FEAT-WIDGETS
//! implements [`DuelEvents`]), the cron (P4-CRON-FEATURES: [`DuelCompletion::tick`] every
//! 500 ms, with [`TwitchDuelModeration`] and the chat delivery).
//!
//! Announcements are plain posts through [`dima_twitch::chat::ChatOut::send`]
//! (`duel/completion.ts:80`, `:88`).
//!
//! # Bounds on what viewers and streamers supply
//!
//! Logins are checked by the command (`^[a-z0-9_]{1,25}$`, P4-CHAT-CMDS-B); channel ids are 1–30
//! digits; settings and rules are the reference's validators (`RULE_LIMITS` with steps, timeouts
//! 1 s to 14 days, two languages, four qualities, only known fields); idempotency keys 1–128
//! characters, 200 receipts kept for 24 h. Stored error texts are cut at 300 characters.

pub mod completion;
pub mod model;
pub mod service;
pub mod stats;

pub use completion::{
    ActionFailure, DuelCompletion, DuelModeration, TickReport, TwitchDuelModeration,
};
pub use model::{DuelChallenge, DuelRecord, DuelRules, DuelRun, DuelSettings, DuelTurn};
pub use service::{
    DuelConfig, DuelDocument, DuelEvents, DuelPhase, DuelService, OverlayPresence, presence_key,
    token_hash,
};
pub use stats::{DuelRanking, DuelStats, Leaderboard};
