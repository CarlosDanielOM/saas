# Routing observation: AI credit projection and receipt producer — 2026-10-29

This note records task-specific routing and evidence for the bounded AI credit/receipt migration. It does not revise the model tier order or the routing summary in [`README.md`](README.md).

## Work routing

Initial GPT-6.1 Terra xhigh attempts returned incomplete authored drafts for the bounded credit/receipt implementation. The same scoped completion was then assigned to GPT-6.1 Sol xhigh, which supplied the implementation. The parent session handled follow-up source issues: a test-only accessor fix for private `ConnectionInfo.addr`, a disconnect-fixture EOF fix, and a Clippy seed-annotation fix. The first two were test harness issues, not application defects.

Terra high authored the fair producer benchmark and shared loader. The parent then hardened raw f64-bit reporting and seven-sample checksum handling. The benchmark work was split across bounded implementation and review tasks; those results are not a controlled comparison of model capability.

## Verified baseline outcome

Baseline source SHA-256: `77fc976da064a87c02ec1fce93cd0e4820dfe53a7eac9feb5fab453c482d80f7`. The projection and receipt implementation commits are `e8b41990` and `c2a0d6f7`. The full compiler fixture run passed in 269.868 seconds total / 259.765 seconds script time. Strict standalone and all-feature formatting/check/Clippy plus no-feature checks passed. The 178 reported test executions include dependency overlap and a subprocess-only no-op helper; they are not 178 unique tests. Post-Node replay passed with the same source hash. Read-only production inspection found 19 records unchanged.

The prepared receipt benchmark medians (TypeScript / Rust, microseconds per operation) were: typed ASCII `5.488255 / 5.582935` (near parity), typed Unicode `6.597315 / 5.710032`, lossless nullish `5.272826 / 5.741841` (Rust 8.895% slower), lossless surrogate `6.512388 / 5.661869`, and lossless large `37.699973 / 8.833420` (4.27× faster). This measures builder + wire + UTF-8 byte summation, excluding Redis, setup, and clock I/O. The TypeScript trials were reused after an explicit native-hash-only rebinding audit; baseline/new input hashes are `72a0a095c23891dd0b38bdc095ad5b09018c20dd5f7df98da3bd004e07f34fda` and `2a281ba3d198a30f81b84eff7a53b907344c57027e2ac203d900583d52895732`.

## Final optimization evidence

The bounded native classification-map optimization is commit `01d35033`, source SHA-256 `02ab55a9d484c01af695793b55d6313280f30080c76db5ad9b5a909b440ac78f`. It skips building a temporary classification map for non-adjustment receipt kinds. Source parity matched all 338 receipts, 20 retention cases, and 3,325 assertions. `compiler-fixtures-1793256739341677553` passed in 184.692 seconds total / 174.613 seconds script time; `node-1793256972582181383` passed against the same source hash. The final producer run passed its ordinary/source and real Redis checks, standalone producer strict check/Clippy, all-feature all-target strict check/Clippy, no-feature check, formatting, and release benchmark. Its 26 reported test executions were 19 library, four ordinary receipt, zero ignored ordinary Redis, one source replay, one real Redis, and one release benchmark.

Final TypeScript/Rust medians in microseconds per operation were ASCII `5.488254673 / 4.729704720` (1.16038×, ranges overlap), Unicode `6.597315228 / 4.798382866` (1.37490×), nullish `5.272826218 / 4.931949913` (1.06912×, small), surrogate `6.512388226 / 5.195385979` (1.25349×), and large `37.699973267 / 8.866506592` (4.25195×). All seven checksums matched in every workload. Versus baseline Rust, nullish latency fell 14.105%; large latency rose 0.375%, with overlapping ranges and no material change. Every pool uses `entryKind: usage`; the optimization timings do not measure adjustment receipt performance. The credit projection remains bound to its unchanged baseline source hash `77fc976da064a87c02ec1fce93cd0e4820dfe53a7eac9feb5fab453c482d80f7` and its full baseline validation; the final producer binding is distinct.

No timing difference is attributed to a model or model capability. These task-specific outcomes do not establish a general Terra/Sol ranking, runtime tier conclusion, or Sol/Astra escalation. See the [migration note](../migration-notes/ai-credit-receipt-2026-10-29.md) and its [evidence index](../migration-notes/evidence/2026-10-29-ai-credit-receipt/README.md) for scoped migration status and evidence.
