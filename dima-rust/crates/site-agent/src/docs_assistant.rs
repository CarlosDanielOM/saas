//! The public docs assistant: the prompt, its tools, its corpus and the answer flow (a public LLM
//! endpoint limited per address). Package **P4-SA-TOOLS-B** fills this module; it is empty until
//! then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai/docs_assistant/docs_assistant.ts` (199 lines): `DocsAssistantInputError`,
//!   `answerDocsQuestion`, `countQuestion`, `parseDocsAssistantRequest`, `recordAnswer`,
//!   `recordFailure`, `recordFeedback`
//! - `utils/ai/docs_assistant/docs_assistant.prompt.ts` (116 lines)
//! - `utils/ai/docs_assistant/docs_assistant.tools.ts` (107 lines): `searchAstFunctionsTool`,
//!   `testCommandTool`
//! - `utils/ai/docs_assistant/docs_source.ts` (82 lines): `getDocsCorpus`
