# Official client compatibility

The single Rust `nset serve` process serves the UI, native API, MLflow tracking routes and W&B tracking routes on one origin. Start it as shown in `README.md`; there is no separate compatibility server, Python serving runtime, proxy or secondary port. Training programs keep their official SDK imports and logging calls and configure the endpoint and credentials instead.

The following is the intended, scoped compatibility contract. It is not full vendor-platform parity or a report that the standalone-server acceptance gates have passed. The locked compatibility environment contains MLflow / mlflow-skinny 3.17.2, W&B 0.31.0 and TensorBoard 2.21.0, the versions used by the earlier SDK checks. Current single-process gates must record the versions they actually execute; other versions are unclaimed.

Install the desired SDK on the producer machine. The same private secret authenticates the browser, native clients and SDKs; use at least 40 characters for the tested W&B SDK. It grants access to the whole service, not an isolated tenant. The examples below assume `NSET_TOKEN` contains the server's secret. Replace the loopback origin with the server address for a remote producer; do not send plaintext credentials across an untrusted network. Local loopback use needs no additional service.

## MLflow

Configure the official MLflow client on the training machine:

```sh
export MLFLOW_TRACKING_URI=http://127.0.0.1:8080
export MLFLOW_TRACKING_TOKEN="$NSET_TOKEN"
```

The scoped workflow covers experiment/run creation, parameter and tag logging, scalar and batch metric logging, completion, run/history lookup, constrained search, lifecycle delete/restore and retry after server restart. Parameters are immutable and tags mutable. External experiment/run IDs map to native records. Exact repeated metric identities deduplicate; latest values follow MLflow's step/timestamp/value ordering rather than native insertion order.

Search supports an AND-separated comparison subset over supported attributes, metrics, params and tags, with LIKE/ILIKE, ordering and query-bound continuation tokens. Unsupported expressions must fail explicitly rather than being partly ignored. Pagination is live, not a snapshot spanning requests.

Artifact upload, listing and download, logged-model APIs, model registry/logging, datasets/input logging and tracing/evaluation are unsupported. Framework autologging is not universally compatible because it may invoke those APIs. Invalid/non-finite metrics and values outside native key, step and timestamp bounds are rejected.

Write metrics for an MLflow-mapped run through its MLflow adapter so its identity/latest-value indexes remain authoritative. The native UI can inspect those observations. MLflow names, lifecycle and status vocabulary are compatibility metadata: renaming need not change the creation-time native display name, and soft deletion does not remove native observations. Native image logging is separate and remains supported.

## W&B

Keep the official `wandb` package on the training machine and configure:

```sh
export WANDB_BASE_URL=http://127.0.0.1:8080
export WANDB_API_KEY="$NSET_TOKEN"
export WANDB_ENTITY=local
```

The scoped workflow covers `wandb.init`, configuration and summary updates, scalar logging, console streams, `finish`, `resume="must"` after server restart, retry after an outage, and offline capture followed by official `wandb sync`. Repeated sync of the same offline run is intended to preserve scalar identity rather than duplicate observations. These paths require real-SDK acceptance tests, not just mocked protocol tests.

Scalar history is projected into native metrics. Accepted raw history, events, output and summary are retained in compatibility tables; nested or nonrepresentable values are not falsely shown as scalar plots. Stream offsets and indexed rows support incremental append/resume; the request-size bound is not a lifetime history limit.

Run-file, media and Artifact uploads/downloads are unsupported and return explicit errors. The SDK may report file-upload rejection warnings. Tracking and completion behavior in the presence of those warnings is part of the SDK gate, not a claim of upload support. Sweeps, registries, full Public API coverage, GraphQL fragments and protobuf file-stream transport are unsupported. Unknown operations fail explicitly; optional telemetry is not falsely acknowledged.

## TensorBoard: optional producer-side collector

Existing TensorBoard/PyTorch/TensorFlow writers keep writing standard `tfevents` files. Run the optional collector where the files are accessible, preferably beside the writer. From a source checkout, install `pip install './python[tensorboard]'` in that producer environment, then run:

```sh
python -m nset_compat.tensorboard --logdir ./training-logs \
  --url http://127.0.0.1:8080 --state-dir ./tensorboard-state --watch
```

The collector uses `NSET_TOKEN`. It is a producer that sends native HTTP requests, not part of the server runtime. Each relative log directory maps to a native run. Legacy `simple_value` and real rank-zero tensor scalars are supported, with wall time converted to milliseconds. The collector currently requires POSIX file locking (Linux/macOS).

Images, histograms, text, graphs and other non-scalar event records are retained locally by the collector rather than represented as native image-chart frames or scalar plots. Warnings and counts expose unsupported/nonrepresentable records. Native history is append-only; TensorBoard orphaned-step purge semantics are not reproduced.

The collector requires append-only regular local files. It checkpoints file identity, record position and acknowledged-prefix digest after durable receipt validation and local preservation. Truncation or rewriting fails closed; missing files do not erase pending delivery state. Full prefix checking costs O(processed bytes) per scan. Keep source logs and collector state until delivery is confirmed, and back them up together; do not delete or move state to bypass a retry failure or assume deduplication across different event files.

## Durability and operations

Compatibility metadata, external IDs, raw streams and pending protocol operations live with native tables in `nset.sqlite3`. Native durable intake uses `ingest.sqlite3` in the same `--db-path` root. A replay-safe pending operation must survive interruption before success is returned. Producer buffering/retries still matter before server acceptance: a client error is not proof that no data reached the service. See `docs/durable-ingestion.md` for receipts and outbox behavior.

Shut down the one server and back up the complete root: both databases, native images, ownership lock and any WAL/SHM sidecars. Do not mix independently timed query and journal copies. Producer outboxes, offline run records and collector source/state remain producer data with their own retention needs. Pending limits do not cap total disk use; monitor receipts, raw records, images and SQLite overhead. No automatic retention policy is implied.

There is no migration or backward-compatibility promise for prior test-data server layouts. Historical gateway results in `docs/durable-ingestion-evidence.md` do not validate the single Rust process; current source-specific acceptance results must be recorded separately.
