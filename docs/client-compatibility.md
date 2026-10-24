# Official client compatibility

nset implements selected official MLflow and W&B tracking protocols through an optional server-side Python gateway. Training programs keep their existing SDK imports and logging calls; configure their endpoint and credentials instead of installing a custom training client. TensorBoard keeps its standard event writers and uses a separate collector because its input is event files, not an HTTP tracking API. This is tracking compatibility, not a clone of either vendor's complete service.

The tested SDK versions are MLflow / mlflow-skinny 3.17.2, W&B 0.31.0 and TensorBoard 2.21.0, locked in the optional Pixi `compat` environment. Other versions may work but are not claimed tested. The gateway and collector currently require POSIX file locking (Linux/macOS); this does not change the native Rust server's platform scope.

## Start the gateway

Build and start the native server as described in `README.md`, then launch the gateway with the same token. Use a token at least 40 characters long for the tested W&B client; a randomly generated 48-character hexadecimal token is suitable. The token grants access to the entire service, not an isolated tenant.

```sh
# NSET_TOKEN must contain the same secret used by the native server.
pixi run compat-serve --native-url http://127.0.0.1:8080 \
  --data-dir ./compat-data --listen 127.0.0.1:3001
```

The gateway itself uses only the Python standard library and the bundled native transport. `pip install ./python` includes `nset_compat`; installed deployments can run `python -m nset_compat` with the same arguments. The official SDKs are test dependencies, not gateway runtime dependencies. Native URLs must be origins without path prefixes. Startup resolves the configured backend hostname once; request workers use those resolved addresses. Restart the gateway after changing backend DNS.

Only one gateway process may own a compatibility data directory. Its persisted state is bound to the native URL; token rotation and public-URL changes are allowed. Do not point an existing compatibility directory at a different backend or delete it to bypass a retry failure. Request bodies default to 32 MiB, with 16 bounded handler workers; configure `--max-body-bytes` and `--workers` deliberately. Native metrics still obey their own request/observation limits. Use TLS or a tunnel for remote traffic.

## MLflow

On the training machine, configure the official MLflow client:

```sh
export MLFLOW_TRACKING_URI=http://127.0.0.1:3001
export MLFLOW_TRACKING_TOKEN="$NSET_TOKEN"
```

Verified workflows include `set_experiment`, `start_run`, parameter/tag logging, scalar and batch metric logging, completion, run/history lookup, search, lifecycle delete/restore, and gateway/backend restart. Parameters are immutable; tags are mutable. Exact overlapping metric observations deduplicate across retries and batches. Latest values use MLflow's step/timestamp/value ordering. Indexed logging and latest-value lookup do not reread full native histories; explicit history retrieval still reads stored observations.

Experiments use persistent external numeric IDs, runs use persistent external hexadecimal IDs, and both map to native records. Search supports a fully consumed AND-separated comparison subset, supported attributes/metrics/params/tags, LIKE/ILIKE, ordering and query-bound continuation tokens. Unsupported expressions fail rather than being partly ignored; pagination is live, not a frozen snapshot across requests.

Artifact upload, listing and download, logged-model APIs, model registry/logging, datasets/input logging, and tracing/evaluation are unsupported and return explicit errors. Framework autologging is not claimed universally compatible, since it can invoke those unsupported APIs. Non-finite values, negative zero, negative or out-of-range steps/timestamps, missing metric timestamps, and names/keys outside native limits are rejected explicitly.

Mapped-run metric writes must go through the MLflow adapter to keep its identity/latest-value index authoritative; read-only use of the native UI is supported. MLflow names, lifecycle and exact status vocabulary live in compatibility metadata. Native display names retain their creation-time name after a rename, and MLflow soft deletion does not remove native observations. Native image logging is separate and remains supported.

## W&B

On the training machine, keep the official `wandb` package and configure:

```sh
export WANDB_BASE_URL=http://127.0.0.1:3001
export WANDB_API_KEY="$NSET_TOKEN"
export WANDB_ENTITY=local
```

Verified workflows include `wandb.init`, configuration and summary updates, scalar logging, console capture, `finish`, `resume="must"` after gateway restart, retry through a native-backend outage, and offline capture followed by official `wandb sync`. Repeated synchronization of the same offline run does not duplicate projected scalar observations. Scalar history is projected into native metrics; accepted raw history, events, output and summary are retained rather than silently dropped.

Streams use indexed rows and bounded resume metadata: appending a batch does not reread or serialize the run's accumulated history. The per-request size limit is not a lifetime stream limit. Raw records and metric identities remain on disk.

Run-file, media and Artifact uploads and downloads are unsupported and return explicit errors. The default SDK may report file-upload rejection warnings; tested tracking and completion still succeed. Nested/nonrepresentable data remains raw compatibility data rather than a scalar plot. Sweeps, registries, full Public API coverage, GraphQL fragments and protobuf file-stream transport are unsupported. Optional SDK analytics may report unauthorized warnings; telemetry is not falsely acknowledged. Unknown protocol operations fail explicitly.

## TensorBoard

Existing TensorBoard/PyTorch/TensorFlow writers keep writing standard `tfevents` files. Run the collector where those files are accessible, preferably alongside the writer, and send to the native HTTP endpoint:

```sh
pixi run -e compat tensorboard-ingest --logdir ./training-logs \
  --url http://127.0.0.1:8080 --state-dir ./tensorboard-state --watch
```

Installed deployments can use the optional `nset-client[tensorboard]` extra and `python -m nset_compat.tensorboard`. The collector uses `NSET_TOKEN`; no change to the training writer is required. Each relative log directory maps to a native run. Legacy `simple_value` and real rank-zero tensor scalars are supported, with wall time converted to milliseconds. Tests use the official `EventFileWriter`, including tensor-content and repeated-field encodings, partial records, rotation, lost replies and server/collector restart.

Legacy images and modern images-plugin tensors are preserved in the collector's local SQLite artifacts, not uploaded as native image-chart frames. Original event protobufs are retained, including histograms, text, graphs, unsupported/nonrepresentable values and restart records; warnings and counts make this visible. Back up collector state as well as source logs. Native history is append-only: TensorBoard orphaned-step purge semantics are not reproduced.

The collector requires append-only regular local files. It checkpoints source identity, record position and acknowledged-prefix digest only after durable receipt validation and local preservation. It detects truncation/rewrites and fails closed; missing files do not erase pending delivery state. Full prefix checking costs O(processed bytes) per scan. Do not delete or move state as a retry mechanism, and do not assume deduplication across different event files.

## Durability, verification and boundaries

The gateway persists protocol identities and pending operations before native metric delivery. Native durable acceptance and query visibility are distinct, and upstream-client buffering/retry behavior still matters before acceptance. Retain W&B offline files and TensorBoard source/state data until delivery is confirmed. MLflow logging failures are visible exceptions, not proof that no data reached the service. See `docs/durable-ingestion.md` for the receipt contract, local outbox, configurable concurrency, monitoring and coordinated backup.

Stop the services before copying the complete native data directory, gateway SQLite/WAL directory and collector state. Pending limits do not bound total disk usage; receipts, indexed identities, raw records and native images require monitoring and have no automatic retention/garbage collection policy. Do not mix independently timed backups of query and journal databases.

```sh
pixi install -e compat --locked
NSET_WANDB_SDK_TEST=1 pixi run -e compat compat-test
```

The SDK gate exercises real official clients over HTTP, explicit upload rejection, exact native-metric readback, restart and failure recovery. `docs/durable-ingestion-evidence.md` records the separate scalar delivery probes, including one million verified points across 32 runs and eight experiments. Those probes do not establish a production SLA or the throughput of every compatibility operation.
