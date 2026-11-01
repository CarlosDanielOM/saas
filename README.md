# SaaS Workspace

This repository contains the DomDimaBot SaaS applications and supporting services. The root [`AGENTS.md`](AGENTS.md) describes the production-host boundaries and release workflow; each project has its own guide where applicable.

## Projects

| Project | Purpose | Main stack |
| --- | --- | --- |
| [`dimabot/`](dimabot/) | Backend API, Twitch bot, and scheduled workers | Node.js / TypeScript |
| [`dimasite/`](dimasite/) | Public website and streamer dashboard | Angular |
| [`admin/`](admin/) | Internal administration and system observability UI | Angular |
| [`dimadocs/`](dimadocs/) | Public English and Spanish product documentation | Astro / MDX |
| [`dimafx/`](dimafx/) | Twitch Extension client and API service | HTML / JavaScript, Node.js |
| [`dimadb/`](dimadb/) | Internal Redis and MongoDB console | Angular, Node.js |
| [`dima-analytics/`](dima-analytics/) | Private application and infrastructure observability | Node.js, PostgreSQL |
| [`dima-hoststats/`](dima-hoststats/) | Read-only host and container statistics sidecar | Node.js |
| [`dima-rust/`](dima-rust/) | Rust library and accepted native cron workers | Rust |

This is a single Git repository. Application dependencies and lockfiles are managed within their project directories; the Rust project uses its tracked `Cargo.lock`.

## Working in this checkout

This checkout is the production host. Read the root and owning project `AGENTS.md` before making changes. Repository-only documentation updates need a reviewed diff and `git diff --check`; application releases use the scoped `scripts/saas-ops` workflow described in [`ops/README.md`](ops/README.md). Do not use the human operator's `scripts/dima-update` tool.

The Rust worker migration is paused. Existing deployed native workers remain active; see the root guide for the accepted release and rollback details.
