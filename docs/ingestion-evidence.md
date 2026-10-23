# Initial ingestion evidence — October 23, 2026

## Scope

This is the first implementation slice of `docs/ingestion-compatibility-plan.md`, not a capacity certification or an upstream-client compatibility release. Changes live on `feat/ingestion-compat`; main and the existing preview were not changed. The audit, load harness, admission work and independent review were delegated separately, with implementation in isolated worktrees and reviewed commits integrated on the feature branch.

The backend remains SQLite WAL with synchronous FULL, one writer and two readers. The new native HTTP admission limit is eight simultaneous authenticated write requests, before extraction. The limit is not eight runs and is not an RSS guarantee. Database jobs can survive a lost HTTP response; no automatic retries or native deduplication were introduced. Generic artifacts and all three upstream adapters remain unimplemented.

## Source and environment

Measurements used macOS 15.7.9 arm64, Pixi Python 3.13.17, local loopback HTTP and fresh disposable databases on this workstation. Compiler/test activity was not run concurrently with the measured workloads. Normal machine activity was not controlled. Each benchmark records platform, host, executable, resolved workload, binary digest and storage path; actual disk hardware and background I/O were not profiled.

The unchanged release binary has SHA-256 `22367ec3bb27b74ed50834e8acd4df8d50fe0f64b9b70886aa7aead5ca5f7fd3`. The admission build, produced from source `78b2a8e` in rx r240 (44.99 seconds total), has SHA-256 `1a4852703902d3ab76508f94d7fbec3ea598a108bfc7717537b88f5e4e3dce65`. Later source changes fix benchmark reader selection and documentation, not backend behavior.

## Validation and review

rx r234 passed the original ten pure benchmark-helper tests (command c233, independent verification root). rx r235 failed a new admission test: route-wide middleware changed a saturated unsupported method from 405 to 503. Method-level routing corrected that issue, and extra unsupported POST/PATCH cases were added. The failure is retained rather than hidden.

rx r236 (command c235, independent validation root, 30.36 seconds) passed all 34 Rust tests, including six new admission tests, all 310 web unit tests and 21 Python tests. These cover saturated writes without body polling, authentication precedence, reads/health availability, method errors, permit release on failure/success/cancellation and explicit busy Retry-After responses. The existing 20-producer, 2,000-observation integrity test retains all observations while bounding in-flight requests; saturation has separate tests.

Independent read-only review found no blocking native-admission issue but identified a benchmark bias: some run/key combinations made a history reader repeatedly request empty streams. The fix derives both run and key from a real workload step. rx r243 (c243/q34, independent validation root, 8.50 seconds) passed 22 Python tests, including the new regression, then verified 10,000 exact observations with two runs, two keys and two history readers over real HTTP. No upstream SDK conformance tests or browser end-to-end tests were run in this slice.

## Workload observations

All runs below are independent workload roots, not an optimization lineage. The shared saved query is q34. Commands and complete resolved options are retained by rx; use `rx show RUN` and `rx list events -r RUN --pprint`. Throughput figures are rounded observations from single trials. Do not interpret their differences as statistically established improvement or regression.

rx r232 (c232/q33, 9.20 seconds) is the legacy reciprocal-value, single-writer benchmark: 100,000 points, batch 1,000, approximately 29,700 observations/second and count-only readback. It is historical context, not a matched baseline for the new sentinel payload.

rx r237 (c232/q34, 9.85 seconds) uses the unchanged server with the new deterministic sentinel payload: 100,000 total points, batch 1,000, one writer/run/experiment, no concurrent readers. All observations verified exactly, with no request errors; throughput was approximately 27,200 observations/second and p95 write latency 173 ms.

rx r238 (c238/q34, 8.05 seconds) uses the unchanged server with eight writers sharing one run, three keys and one catalog plus one history reader. All 100,000 observations verified exactly, with no request errors; throughput was approximately 59,500 observations/second and p95 write latency 874 ms.

rx r239 (c239/q34, 9.17 seconds) uses the unchanged server with eight writers/runs across four experiments, three keys and one catalog plus one history reader. All 100,000 observations verified exactly, with no request errors; throughput was approximately 37,400 observations/second and p95 write latency 1,115 ms.

rx r241 (c241/q34, 9.00 seconds) repeats the r239 workload against the admission build. All 100,000 observations verified exactly, with no request errors; throughput was approximately 44,300 observations/second and p95 write latency 1,322 ms. These single trials do not establish a speedup; the long tail remains a reason to profile sustained mixed load.

rx r242 (c242/q34, 7.45 seconds) is an explicit overload diagnostic: 32 producers/runs across four experiments offer 100,000 observations to the eight-write admission build without retries. It exits 1 with success=false because 89 requests receive 503. All 32,000 acknowledged observations verify exactly, with zero missing acknowledged points or integrity errors. The remaining 68,000 observations were not acknowledged. This is evidence of explicit rejection under this workload, not successful ingestion of all offered data or a capacity result.

The r238/r239/r241/r242 configurations use one history reader and three keys with producer counts coprime to three; the reviewed empty-stream pairing problem does not apply to those configurations. r243 separately covers the formerly biased configuration after correction.

## Interpretation and next work

The evidence establishes multi-run data integrity for these bounded scalar workloads, plus explicit write admission and tested busy responses. It does not establish sustained capacity, per-experiment fairness, maximum dataset size, RSS bounds, crash-safe retries, image-load isolation or operational latency targets. Catalog/history reads and image persistence remain profiling targets. Temporary benchmark databases and server logs are deleted on exit; rx retains source snapshots, stdout/stderr and structured events, not those databases.

Next work is a real-client MLflow tracking milestone with version-pinned conformance tests, alongside durable source identity/replay design and generic artifact storage. TensorBoard event ingestion and W&B control/stream protocols remain separate planned milestones. Do not advertise drop-in compatibility before those official-client journeys pass.
