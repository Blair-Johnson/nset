# In-process compatibility contract

The filename is retained for existing references; this is the current single-Rust-server contract, not instructions for operating the former gateway. `nset serve` exposes the embedded UI, native API and scoped MLflow/W&B tracking protocols on one listener. There is no compatibility Python runtime, child process, proxy, backend URL or second serving port. The optional TensorBoard collector is a producer-side native HTTP client.

## Entry points and authentication

`src/compat_http.rs` dispatches MLflow routes under `/api/2.0/mlflow/`, W&B GraphQL at `/graphql` and the supported W&B file-stream path under `/files/`. Unsupported compatibility and file/artifact operations return explicit errors, not the UI document or fabricated success. File streams used for scalar/history transport do not imply generic file-upload support.

All protocol requests authenticate against the same server secret: bearer authentication for MLflow/native clients and W&B's HTTP Basic `api:<token>` form at the compatibility boundary. UI assets remain public; API data and native image bytes require authentication. No credentials belong in URLs or logs. Authentication precedes compatibility admission and body processing.

The boundary uses shared bounded write admission, 32 MiB compressed and decoded request limits, bounded GraphQL argument/response materialization, a 10-second body-intake timeout and a 35-second operation-response timeout. MLflow errors have an `error_code`/`message` envelope; GraphQL errors use an `errors` array. Busy or interrupted operations require replay with the same identity rather than a newly generated batch. These are implementation constraints, not total-memory or latency guarantees.

## Rust modules and persistence

`src/compat/mlflow.rs` and `src/compat/wandb.rs` implement the scoped protocol handlers. `src/compat/mod.rs` shares the native `Database` and `DurableIngest`, provides keyed ordering locks, persists compatibility metadata and submits deterministic native chunks. No HTTP forwarding is involved.

Native tables and compatibility metadata, external IDs, stream offsets, raw records and pending operations share `nset.sqlite3`. `ingest.sqlite3` is the durable scalar intake journal, not a third compatibility database. Both are in the single `--db-path` root with native images, `nset.lock` and WAL/SHM sidecars when present. Root ownership prevents simultaneous servers using the same dataset. Shutdown and backup must cover the entire root together.

Protocol handlers persist operation identity/payload before projection. Shared ingestion binds a stable caller identity to a canonical payload, chunks at the native 10,000-observation limit, checks receipts and waits for applied visibility before protocol success. The native durable endpoint's 202 receipt remains a separate acceptance boundary. A timeout can leave recoverable accepted work; it is not proof that nothing committed. After body validation, an admitted operation retains its run lock and admission permit until completion even when its HTTP waiter disconnects or times out. Graceful shutdown drains these operations, joins query/journal workers, and retains storage-root ownership through runtime shutdown. Multi-chunk operations are not one atomic native transaction.

Mapped MLflow metric writes must preserve the adapter's deduplication and latest-value indexes. W&B append/resume must preserve stream offsets and scalar identities, including repeated offline sync. Unsupported operations must fail without acknowledging discarded data. Native image logging remains available; generic artifacts, run-file/media upload and download are unsupported.

## Scope and verification

`docs/client-compatibility.md` defines the intended producer workflows and exclusions. Real official-SDK tests must cover exact native readback, metadata, lifecycle/search, restart/retry, W&B resume and offline sync, auth and explicit unsupported uploads. Mock handler tests do not establish SDK compatibility. Current gate results must identify source and SDK versions; earlier Python-gateway evidence is historical only.

The public CLI is documented in `README.md`; internal resource controls remain environment tuning, not more serving flags. This test-data-only transition offers no old-gateway state migration or backward-compatibility promise. No performance, complete vendor parity, multi-tenant isolation or release-readiness claim follows from this architecture document.
