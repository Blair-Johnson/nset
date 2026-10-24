# Durable delivery evidence

The durable-ingestion feature was developed in isolated worktrees without changing main or its preview. The server now separates durable intake from query materialization; measurements must distinguish those stages. Operations and retry responsibilities are documented in `docs/durable-ingestion.md`.

## Recovery and regression gates

The integrated Rust/web portion of rx r267 passed 56 Rust tests and all 310 web unit tests. Its Python stage exposed a TensorBoard subprocess import-path fixture error; the corrected invocation in rx r271 passed all 92 then-integrated Python tests, including native HTTP acceptance, SIGKILL/restart replay, capacity retention, concurrent identical-ID replay, authentication, outbox delivery and a real TensorBoard writer-to-native-server recovery journey. These runs preceded the final adapter integration and do not establish W&B or MLflow conformance on their own.

Independent reviews led to fixes for interrupted outbox shutdown, oversized unsendable local batches, malformed journal identity keys, and known-version query databases missing required schema. The outbox follow-up passed 29 focused tests in rx r261 and 100 interrupted-close schedule cases in rx r263. Journal follow-up rx r278 passed 21 focused schema/recovery tests and strict Clippy. TensorBoard follow-up rx r281 passed all 22 tests, including real native-server replay, malformed receipt retention and pending-work query plans. Final combined validation is recorded separately with the compatibility matrix.

## Concurrent delivery probes

rx r283 built the schema-hardened release binary, SHA-256 `db16b05675ade195f356dd2adf26e4a840e85a4a2151399fe181817619195bbe`. rx r285 and r286 are independent workload roots using that same binary, saved query q42. Both use 32 clients/runs, one experiment, 100,000 integer sentinel points, batches up to 1,000, four HTTP workers and two SQLite readers. All observations are first committed to local outboxes. Delivery timers then include retries; query-visibility timers wait for all receipts to become applied. Exact step, timestamp and value readback follows.

With write admission eight, r285 verified all 100,000 points with zero integrity errors and no remaining outbox batches. It observed 1,149 HTTP 503 responses and one transport reset, all retried with stable IDs. Local spooling took 0.814 seconds, server acceptance 1.280 seconds and query visibility 5.223 seconds. The observed acceptance rate was about 78,100 points/second; the query-visible rate was about 19,100.

With write admission sixteen, r286 also verified all 100,000 points with zero integrity errors and no remaining outbox batches. It observed 516 HTTP 503 responses and no transport resets. Local spooling took 0.770 seconds, server acceptance 0.871 seconds and query visibility 1.820 seconds. Observed rates were about 114,800 accepted and 55,000 query-visible points/second.

These are single fresh-database, closed-loop stress trials on a development workstation, with other agent activity not controlled. The deliberately short 20 ms retry interval stresses overload handling; production clients should use backoff and honor Retry-After. The difference between these trials is not a demonstrated scaling factor or a reason to raise defaults universally. Durable data retention through retries is the supported conclusion. No claim is made about sustained capacity, mixed image traffic, bounded total RSS, hardware power-loss behavior or production tail latency.

The first attempt, r280, stopped on a connection reset because the benchmark retried only HTTP 503. The local outbox retained the failed batch; the harness was corrected to retry transport failures with stable IDs and report them separately. Its failure is retained in rx and is not presented as a successful delivery measurement. Temporary benchmark databases are removed on exit; rx retains source snapshots, configuration, binary digests, output and result events.
