# AST command calls

`#(commandName args...)` invokes an enabled custom command and sends its response as a separate chat message. It contributes no text to the containing response.

For example, `!socials` with the response `Join us on: #(discord)` sends:

1. `Join us on:`
2. The response of `!discord`.

References execute after the containing message is delivered, in written order. Each referenced command sends its own message before invoking its children. A response containing only `#(discord)` sends only Discord's response. Arguments work as usual (`#(greet username)`), remain literal when substituted into the called command, and do not inherit the caller's arguments when omitted. Returned text is not parsed a second time.

Calls share a maximum of five nested reference levels and 50 total queued invocations per execution. The active call path is propagated into each command before its body is parsed. Self-calls and indirect cycles are stopped, while siblings can reuse a command. The path, remaining budget, and timer nesting depth also survive one-shot timer recovery.

Referenced and direct custom-command executions share a cache-backed cooldown. Disabled/missing/cooling-down commands are skipped. Existing authorization rules remain: streamer-authored templates execute behind their outer command/event gate; AI references check the requesting chatter's authority before invoking a command. This syntax dispatches custom-command templates, not the built-in chat-command switch.

The parser returns text plus pending `commandReferences`. Consumers must use `deliverAstMessage` (or explicitly drain the references after their own delivery) rather than discarding the queue. The raw chat sender also supports parser contexts and performs the same ordering. If an outer send fails, its references do not execute. Suppressing event chat suppresses returned messages but still runs authored actions.

Relevant files: `src/utils/ast_parser/evaluator.ts`, `src/utils/ast_command_delivery.ts`, `src/handlers/commands.handler.ts`. Isolated functional checks: `ops/checks/ast-command-references.mjs` from the repository root, with `ops/checks/ast-timer-fixtures` and disposable Mongo/Dragonfly dependencies.
