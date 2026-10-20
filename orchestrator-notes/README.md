# Orchestrator model notes

Use this file to keep concise, evidence-based observations that help choose models for future work. Read it before substantive delegation. Update it after a meaningful verified outcome or useful user feedback. These notes support the live orchestrator capability catalog; they do not replace it. Always check that catalog for current providers, exact model identifiers, effort options, and delegation support. Do not treat any identifier or option recorded here as permanent truth.

## Starting preferences

The user's current ascending capability coding tier is a user-provided starting preference:

1. GPT-6 Luna
2. MiniMax M3.1 Flash
3. DeepSeek V4.1 Flash
4. Grok 4.7
5. GPT-6.1 Sol
6. GPT-6 Astra

On 2026-10-20, the user expanded the original five-model baseline by inserting Grok 4.7 between DeepSeek V4.1 Flash and GPT-6.1 Sol. Based on their experience, the user prefers Grok as a stronger reasoning option than V4.1 Flash for more demanding/deeper exploration; this is a routing preference, not a verified benchmark. Use Grok 4.7 at high or xhigh when the live catalog advertises those effort levels. Grok is available through Cursor and Grok CLI/provider, and may also be used for scoped implementation under the same delegation and verification rules.

This is not a mandatory sequential escalation ladder. Choose the best available model for the task up front. Verified outcomes or user feedback may justify revising the working tier as well as routing by task category without another approval request. Keep the user-provided baseline above, and record the date, reason, and supporting evidence for each adjustment.

For GPT-led UI/UX and design tasks, start with DeepSeek V4.1 Flash or GPT-6.1 Sol using the existing effort preferences. The user may manually ask Claude to refine the work later. This preference applies only to GPT-led sessions; it does not set a default for Claude-led sessions.

## Routing observations

Keep observations brief and tied to a task category, scope, and concrete evidence. Consider exploration, single-file or function work, multi-file integration and consistency, optimization, and UI/UX design separately. Confidence should reflect how much evidence exists and how well it transfers to similar tasks. One result can inform a hypothesis; repeated, comparable results support a stronger routing change.

Separate implementation performance (correctness, consistency, rework, and time to a verified result) from generated-code runtime performance (for example, latency, throughput, or resource use). Claim runtime optimization only when measurements support it. A good build or review is not evidence of a runtime speedup.

Do not record secrets, credentials, private user data, or raw logs. Prefer short summaries and references to commits, task records, or check results.

First verified coding-performance observation: [2026-10-20 shared chat origin handling](2026-10-20-shared-chat.md). The current tier includes the user's Grok insertion above; no empirical tier reordering has been established.

## Blank observation template

Copy this block for each meaningful outcome:

```text
Date:
Provider / model / version + effort:
Task category / scope / constraints:
Concrete result and verification evidence (commit, task, or check references):
Rework / failures:
Latency / cost (only when actually measured):
User feedback:
Confidence:
Routing implication:
```
