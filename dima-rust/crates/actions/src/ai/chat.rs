//! The AI chat with tools: the tool loop and the tools that recall and create memories, summarise
//! chat and read stream statistics. The code-execution tool is not offered (owner). Package
//! **P4-ACT-AI-B** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai/openrouter/ai.ts` (lines 764–end, 561 of 1245): `chat`
//! - `utils/ai/tools/index.ts` (137 lines)
//! - `utils/ai/tools/recall_memory.tool.ts` (149 lines)
//! - `utils/ai/tools/create_memory.tool.ts` (153 lines)
//! - `utils/ai/tools/stream_stats.tool.ts` (48 lines): `execute`
//! - `utils/ai/tools/chat_summary.tool.ts` (62 lines)
