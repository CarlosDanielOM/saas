# DimaBot

`dimabot/` contains the DomDimaBot backend: an Express API, Twitch chat bot, EventSub handling, and background workers. The public website and dashboard are in [`../dimasite/`](../dimasite/); public feature guides are maintained in [`../dimadocs/`](../dimadocs/).

## Main features

- Twitch chat commands, moderation, and channel management
- Dashboard APIs for commands, triggers, rewards, analytics, and account settings
- Twitch EventSub and stream activity handling
- AI personality, memory, moderation, and other model-backed features using the providers configured for each feature
- Text-to-speech and media services
- Scheduled TypeScript workers and accepted native Rust workers supervised within the existing cron service
- Dragonfly-compatible caching, MongoDB persistence, and S3-compatible media storage

The backend uses Node.js 24 in its Docker image. Twitch chat messages and other subscribed events enter through EventSub. Model and provider choices depend on the feature and its runtime configuration; the public docs assistant, for example, uses MiniMax.

## Development notes

This is a project inside the [`saas` monorepo](../README.md), not a standalone repository. Dependencies are declared in `package.json`. Before running any application process, review the required environment and service configuration in source and use disposable services and test credentials. Bot, server, and cron development commands start real application processes; do not run them with production credentials or against production queues and data.

Useful package scripts include:

```sh
npm run build
npm run server:dev
npm run bot:dev
npm run cron:dev
npm run test-bot
```

`test-bot` sets `ENVIRONMENT=test` and starts the bot; that setting alone does not isolate external services or credentials, so configure a disposable test environment before using it. `npm test` is currently a placeholder that exits with an error; use the relevant existing source suites and behavior checks for a change. For supported releases, follow [`../ops/README.md`](../ops/README.md) and the `scripts/saas-ops` target for the affected service.

## Cron workers

The existing `dima-cron` service has a TypeScript supervisor and a Rust index in the same container. Each supervisor owns and restarts its own worker children. Scheduled TypeScript worker definitions are registered in `src/workers/cron.index.ts`; native workers are registered in `../dima-rust/src/supervisor/registry.rs`. Do not add a second cron service. See the cron architecture and current accepted release details in the root [`AGENTS.md`](../AGENTS.md#cron-workers-architecture-important).

## Further backend guidance

- [`AGENTS.md`](AGENTS.md) covers backend architecture, current release evidence, security boundaries, and delivery checks.
- [`DOMAIN_EVENTS.md`](DOMAIN_EVENTS.md) documents event producers and consumers.
- [`OVERLAY_WIDGET_MODULES.md`](OVERLAY_WIDGET_MODULES.md) documents the portable Overlay Studio widget contract.
- HTTP request and response contracts live in `src/server/routes/*.route.ts`; route registration and middleware order are in `src/server/server.ts`.
