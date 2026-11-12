//! The built-in chat commands. Packages **P4-CHAT-CMDS-A**, **P4-CHAT-CMDS-B** fill this module
//! (each its own files); it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `commands/amor.command.ts` (54 lines): `amorCommand`
//! - `commands/command_list.command.ts` (52 lines): `commandListCommand`
//! - `commands/disable_command.command.ts` (32 lines): `disableCommandCommand`
//! - `commands/enable_command.command.ts` (32 lines): `enableCommandCommand`
//! - `commands/followage.command.ts` (113 lines): `followageCommand`
//! - `commands/poll.command.ts` (89 lines): `pollCommand`
//! - `commands/prediction.command.ts` (141 lines): `predictionCommand`
//! - `commands/add_moderator.command.ts` (46 lines): `addModeratorCommand`
//! - `commands/add_vip.command.ts` (136 lines): `addVipCommand`
//! - `commands/remove_moderator.command.ts` (49 lines): `removeModeratorCommand`
//! - `commands/remove_vip.command.ts` (50 lines): `removeVipCommand`
//! - `commands/title.command.ts` (76 lines): `titleCommand`
//! - `commands/game.command.ts` (107 lines): `gameCommand`
//! - `commands/only_emotes.command.ts` (88 lines): `onlyEmotesCommand`
//! - `commands/command_manager.command.ts` (453 lines): `createCommand`, `deleteCommand`,
//!   `editCommand`
//! - `commands/duel.command.ts` (56 lines)
//! - `commands/index.commands.ts` (44 lines): `indexCommands`
//! - `commands/miyuloot.command.ts` (121 lines)
//! - `commands/ruletarusa.command.ts` (138 lines)
//! - `commands/shoutout.command.ts` (168 lines): `handleShoutoutCommand`
//! - `commands/sumimetro.command.ts` (137 lines): `sumimetroCommand`
//! - `commands/sumimetro_ast_message.ts` (55 lines)
//! - `commands/vanish.command.ts` (80 lines)
//! - `commands/promo.command.ts` (103 lines)
//!
//! P4-CHAT-CMDS-A ports the first fourteen and owns this file; P4-CHAT-CMDS-B adds one file per
//! command it ports beside them. `create_clip.command.ts` is `dima_actions::host::media`
//! (P4-ACT-MEDIA) and `timer_manager.command.ts` is `dima_features::timers` (P4-FEAT-TIMERS).
