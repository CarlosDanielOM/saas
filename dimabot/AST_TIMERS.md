# One-shot AST timers

A command or reward can schedule a message and actions without waiting:

```text
Streamer cannot talk for 5 minutes! $(timer 300 5 minutes over! $(trigger.send hurray))
```

The initial text is returned immediately. After 300 seconds the bot evaluates the timer body, fires the configured `hurray` trigger, and sends `5 minutes over!` to the same channel. The trigger must exist, be enabled, and have its overlay connected. An action-only timer does not send an empty chat message.

- Syntax: `$(timer seconds message_and_actions)`. Seconds may be an AST expression; the remaining body is evaluated only when due. Quote the body when exact punctuation/spacing matters, as with other AST function arguments.
- Each invocation creates an independent timer. Use the command's cooldown to control repeated uses.
- Duration: 1 second through 7 days. Up to 100 pending timers per channel, 10,000 globally, 64 KiB per saved job, and five directly nested timer generations.
- Jobs remain in Dragonfly until execution or **10 minutes after their deadline**. The grace period is fixed in this version. On bot restart, overdue jobs inside the grace period execute; older jobs are discarded. Recovery depends on Dragonfly retaining its data.
- The bot owns `setTimeout` handles and reconciles the pending index every two seconds. API/cron parser consumers can enqueue jobs; they do not run a second executor. Under load or during recovery, execution can occur after the exact deadline.
- Caller identity, permission enforcement, command scope, event data, loop values, and in-memory variables are captured at scheduling. Persistent variables are read when the job runs. Literal command arguments remain literal. The timer returns no ID or immediate success message.
- Execution is **at most once**: an atomic cache operation consumes the job before evaluating it. Multiple bot instances cannot replay the same job. A crash after claiming, a failing action, or an unavailable external service may lose the action; it is not retried automatically.

Implementation: `src/utils/ast_parser/timer.ts` defers evaluation, `src/utils/ast_timer_runtime.ts` stores/recovers/claims jobs, and `src/bot/index.ts` starts the scheduler. No separate worker or container is required.

Verification: `ops/checks/ast-timer.mjs` (from the repository root) runs against disposable Mongo/Redis with the provider boundary in `ops/checks/ast-timer-fixtures`. It exercises the normal service entrypoint, real AST and trigger handlers, cache persistence, killed/restarted scheduler processes, duplicate claims, and expiration without contacting Twitch.
