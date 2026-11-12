//! The tool registry: lookup, undo tools, the model-facing tool list, result text. Package
//! **P4-SA-TOOLS-B** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/tools/registry.ts` (63 lines): `getTool`, `getUndoTool`, `toLlmTools`,
//!   `toolResultText`, `toolsFor`
