//! The API's in-process implementations of `dima_twitch::functions::chats::speech::BackendApi` and
//! `dima_twitch::functions::clips::ClipPublisher`, so that an evaluation running in the API
//! (simulation, the site agent, the EventSub test route) does not call itself over HTTP. Packages
//! **P4-RT-SOCKETS**, **P4-RT-CLIP-FX** fill this module (each its own files); it is empty until
//! then.
//!
//! No TypeScript file of its own (plan section 2.1). P4-RT-SOCKETS creates the `BackendApi` side as
//! the queues land; P4-RT-CLIP-FX adds the `ClipPublisher` (plan section 5.1). The bot and the cron
//! implement the same traits over HTTP and pub/sub in `dima_actions::backend`.
