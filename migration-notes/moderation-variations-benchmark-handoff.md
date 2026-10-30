# Moderation variations matched benchmark handoff

The three-round matched synthetic benchmark is complete. Full methodology and limitations are in [the migration note](moderation-variations.md); complete compressed reports and samples are in [the evidence package](evidence/2026-10-30-moderation-variations/index.json).

Each round used 70 fresh actors: seven fresh Node/Rust pairs for each of five workloads (`term`, `key`, `build`, `spacing`, `patterns`), alternating actor order. Three complete warmups each ran 8,000 calls over 32 unique terms on one shared pool. Every actor passed independent output hash, checksum, and median checks. The immutable input SHA-256 is `07b8192f942ef9c3246720aa75926939260f3e07250d83b7973197ca6ac65d2e`.

All rounds, including slower results, are retained at `artifacts/paired-attempt{1,2,3}/variations-paired-report.json.gz`. Final Node/Rust medians (ns/op): term 482.541375/413.524625; key 3436.8805/1901.26775; build 12002.5345/11032.778; spacing 2209.778/315.167875; patterns 6896.48975/4146.829125. Term and build ranges overlap. Early rounds showed term regressions and the first patterns regression; all samples remain reported. This prepared warm-cache synthetic workload establishes no statistical significance, production throughput, CPU, or RSS result.
