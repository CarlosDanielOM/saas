//! The command editor's simulation: a test run where every function call is answered by
//! `dima_engine::host::Host::simulate`. Package **P4-ACT-CORE** fills this module; it is empty
//! until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ast_parser/simulate.ts` (295 lines): `SimulationInputError`, `parseSimulationInput`,
//!   `simulateCommand`
