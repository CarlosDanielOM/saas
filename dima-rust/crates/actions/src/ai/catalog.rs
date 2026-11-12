//! The AST catalog: the function catalog built from the registry, its vectors in Qdrant, and the
//! two tools that search it and run command language. Package **P4-ACT-AI-C** fills this module; it
//! is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai/ast_catalog/index.ts` (216 lines): `ensureAstCatalogVectors`, `findAstCatalogEntry`,
//!   `getAstCatalog`, `searchAstCatalog`
//! - `utils/ai/ast_catalog/build_catalog.ts` (138 lines): `buildCatalogFromRegistry`,
//!   `renderAuthoringDocs`
//! - `utils/ai/tools/ast_docs.tool.ts` (53 lines): `execute`
//! - `utils/ai/tools/ast_parser.tool.ts` (187 lines): `execute`
//!
//! The `ast_parser` tool evaluates its program through `crate::runner::CommandRunner::run_program`.
