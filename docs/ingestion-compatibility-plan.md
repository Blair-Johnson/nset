# Concurrent ingestion and client compatibility

Status: planning and baseline audit. Branch `feat/ingestion-compat`, based on `cea8ccd`. Production behavior is unchanged at this milestone.

## Goal and acceptance contract

Existing MLflow and W&B instrumentation should work through endpoint and authentication configuration, without importing an nset client or monkey-patching upstream packages. Compatibility is a tested feature and SDK-version matrix, not a claim of complete replacement. TensorBoard compatibility means consuming standard event files without changing training logging calls; a shared log directory or external collector is required when those files are not accessible to the server. An HTTP endpoint alone is not a substitute for a TensorBoard log directory.

Ingestion must preserve isolation between runs and experiments, acknowledge only committed data, apply bounded resource use under overload, and have explicit retry/replay semantics. Concurrent writers, dashboard readers, large batches and artifact transfers must be assessed together. Do not weaken durability to improve headline throughput.

## Baseline and architecture decisions

The current Rust backend already uses SQLite WAL with synchronous FULL, a dedicated writer actor, two read-only actors and bounded queues. Keep this design until measurements identify a limiting resource. The existing benchmark measures only one sequential scalar stream. Add a reproducible multi-run, multi-experiment benchmark with concurrent readers, batch-size controls, latency percentiles, overload/error counts and exact history verification. Record source revision, binary digest, environment and workload with rx. Use disposable databases, never the user's preview data.

Before adding adapters, document timestamp units, run identity, parameter mutation, metric identity, repeated steps, status transitions and artifact semantics. Protocol-specific replay identity must not collapse legitimate repeated native observations. Persist external run mappings and resume offsets transactionally with accepted data where required. Avoid independent adapter queues that bypass shared limits or acknowledge work before persistence.

## Delivery sequence

Milestone A establishes the concurrent baseline, audits request admission and long-read behavior, and publishes the compatibility matrix. Its exit gate is reproducible load evidence with exact per-run verification, not an unmeasured throughput promise.

Milestone B hardens measured bottlenecks and overload behavior with bounded admission, isolated artifact I/O where necessary, retry-safe adapter ingestion and schema migration tests. Each change must retain native API contracts and have before/after evidence. Database replacement and distributed writes are out of scope unless the measurements justify them.

Milestone C implements MLflow tracking first: experiment/run lifecycle, parameters, tags, scalar batches/history and artifact transfer. Tests use real upstream SDK calls with only tracking URI/authentication configuration. Search, pagination, immutable parameters, duplicate delivery and failure responses require explicit semantics. Model registry, newer model/trace APIs and framework autologging remain unclaimed until separately tested.

Milestone D implements TensorBoard event ingestion with checkpointed file positions, rotation/restart handling, partial-record safety and explicit run mapping. Test standard scalar encodings and images first; unsupported event types must be reported, not silently presented as supported.

Milestone E implements the W&B SDK transport incrementally, including initialization/capability negotiation, run identity, history/summary streaming, completion, resume and files. Pin and test upstream clients; returning fabricated success for unsupported GraphQL operations or discarding uploaded data is not compatibility. Sweeps, registries and advanced artifact semantics require their own coverage.

## Parallel work and integration discipline

The integration worktree owns the plan and cross-cutting design. Read-only reviewers independently audit storage and adapter semantics. Implementation workers use separate branches/worktrees and explicit file ownership. Review each diff and focused test evidence before bringing it into the integration branch. Keep plan, benchmark, storage and adapter commits separate. Do not push or merge into main as part of this initial audit.

## Verification gates

Test simultaneous producers across several experiments, same-run concurrent producers, small and maximum-size batches, dashboard reads during writes, bounded overload, retries after ambiguous acknowledgements and restart recovery. Verify values, steps, timestamps and stream isolation, not just counts. Record throughput and p50/p95/p99 latency with rejected and retried requests reported separately. Hardware-specific results are observations, not service guarantees.

Run the native Rust/Python suites and relevant UI/API tests after backend changes. Compatibility tests must use official clients, cover success and failure paths, and record exact versions. Include non-finite metrics, repeated steps, pagination, unsafe artifact paths, auth failure and unsupported operations. Claims in the README must match the tested matrix.

## Upstream evidence

MLflow's official REST API reference defines tracking endpoints under `/api/2.0/mlflow` and artifact endpoints separately. Its tracking-server documentation describes configuring clients with `MLFLOW_TRACKING_URI`.

W&B's upstream `wandb/env.py` defines `WANDB_BASE_URL` and `WANDB_API_KEY`; its `core/internal/filestream/filestream.go` defines separate history, summary, event and output streams with resume offsets. Further initialization/GraphQL behavior needs SDK-level verification.

TensorBoard's upstream README documents append-only `tfevents` files read from a log directory and per-directory run discovery. Treat ingestion of these files as a separate path, not a shared HTTP tracking protocol.
