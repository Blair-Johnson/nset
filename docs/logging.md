# Logging and delivery

Start the server as shown in the [README](../README.md). All clients use its address and shared access token. Replace loopback addresses below for remote training, and protect credentials with HTTPS or a secure tunnel.

## Native Python client

Install `pip install ./client` from the checkout in a Python 3.10+ training environment. The [README example](../README.md#log-data) creates an experiment and run. Inside that run, log scalars and an existing PNG, JPEG, or WebP file:

```python
run.log_metrics({"train/loss": 0.23, "train/accuracy": 0.94}, step=100)
run.log_image("train/prediction", "prediction.png", step=100)
```

`run.log_batch(rows)` accepts dictionaries with `key`, `step`, `value`, and optional `timestamp`. `client.metric_history(run.id, "train/loss")` iterates the complete paginated history. Exiting the run context marks it finished, or failed when an exception escapes.

- Each scalar request contains 1–10,000 observations and commits atomically. Metric values must be finite; names and keys are 1–512 UTF-8 bytes.
- Steps and timestamps are integers from 0 through 9,007,199,254,740,991. Timestamps are Unix epoch milliseconds; omission uses server acceptance time.
- Request bodies are limited to 32 MiB. Images also undergo decoding checks, with a 32,768-pixel limit per dimension and a 256 MiB decoder allocation limit. Original image bytes are retained.
- Ordinary logging calls are synchronous and have no automatic retries. Repeated scalar writes append observations. A lost response can leave a committed write, so blindly retrying can duplicate data.

## Durable scalar delivery

For retry-safe scalar logging, use a local outbox inside an active native run:

```python
with client.durable_outbox("training-outbox.sqlite3") as outbox:
    batch_id = outbox.enqueue(run.id, [{"key": "loss", "step": 100, "value": 0.23}])
    outbox.flush()
```

`enqueue` commits locally and returns a stable batch ID. `flush` sends pending batches, removes each only after a matching server receipt, and raises on delivery failure while retaining failed rows. Reopen the same spool with the same destination to resume; pending rows already contain their run IDs. Protect the spool directory: it contains plaintext observations. Run creation, completion, and image logging remain separate synchronous calls.

Call `outbox.start()` for background delivery with backoff. Context entry leaves delivery stopped; `close()` and context exit stop workers without draining pending rows. Check `pending_count()` and `last_error`. Correct authentication, validation, and conflicting-ID errors before retrying. Socket timeouts bound individual socket operations; DNS resolution or a trickling peer can delay shutdown.

The underlying authenticated endpoint is `PUT /api/runs/{run_id}/ingest/{batch_id}`, with body `{"metrics":[{"key":"loss","step":100,"value":0.23}]}`. Batch IDs are 1–128 ASCII letters, digits, dots, underscores, or hyphens, scoped to a run. Retrying the same ID and canonical payload returns the original receipt; different data under that ID returns HTTP 409. Preserve timestamps, including their omission, on retries.

HTTP 202 acknowledges a durable journal commit. Query visibility follows asynchronously. `GET` on the same path returns `state` (`pending` or `applied`), `accepted` (observation count), and `accepted_at` (milliseconds). A pending receipt is enough for the outbox to release its copy. Journal replay preserves batch identity across server restarts; durability depends on storage honoring synchronization.

## MLflow

Install the official MLflow SDK in the training environment and configure:

```sh
export MLFLOW_TRACKING_URI=http://127.0.0.1:8080
export MLFLOW_TRACKING_TOKEN="$NSET_TOKEN"
```

Supported tracking includes experiment/run creation, parameters, tags, scalar and batch metrics, completion, history lookup, search, and lifecycle delete/restore. Parameters are immutable; tags are mutable. Exact repeated metric identities deduplicate, and latest values follow MLflow's step/timestamp/value ordering. Keep writes for MLflow-created runs on the MLflow path so these indexes remain consistent. Renames and soft deletion are MLflow metadata; native observations remain available.

Search supports AND-separated comparisons over supported attributes, metrics, parameters, and tags, including LIKE/ILIKE, ordering, and query-bound pagination. Pages reflect live data. Unsupported expressions return errors.

Artifact APIs, model logging/registry, datasets/inputs, tracing, and evaluation are unsupported. Framework autologging can invoke these APIs, so compatibility is limited to the tracking operations above.

## W&B

Install the official `wandb` SDK in the training environment and configure a token of at least 40 characters:

```sh
export WANDB_BASE_URL=http://127.0.0.1:8080
export WANDB_API_KEY="$NSET_TOKEN"
export WANDB_ENTITY=local
```

Supported workflows include `wandb.init`, configuration and summary updates, scalar logging, console streams, `finish`, `resume="must"` after restart, and offline capture followed by `wandb sync`. Stream identity supports retries and repeated sync of the same run. Scalar history appears in native charts; nested history and other raw stream records are retained as compatibility data.

W&B file, media, and Artifact uploads/downloads, sweeps, registries, full Public API coverage, GraphQL fragments, and protobuf file-stream transport are unsupported. Normal SDK tracking may emit file-upload rejection warnings. Log images with the native client.

These adapters implement a scoped tracking subset. The locked SDK test environment uses mlflow-skinny 3.17.2 and W&B 0.31.0; other versions need validation. See [development checks](contributing.md#checks).

## Server storage and recovery

Keep the `--db-path` directory on local storage. Stop the server before backing up the whole directory together: `nset.sqlite3`, `ingest.sqlite3`, native images, `nset.lock`, and any SQLite WAL/SHM sidecars. Restore them from the same backup. Producer outboxes and W&B offline runs also need retention until delivery is confirmed.

Authenticated `GET /api/ingest/status` reports pending batches/bytes and the last projection error. A damaged batch remains pending and blocks later projection; preserve the databases while investigating. Capacity errors retain accepted batches. Retry temporary delivery failures with stable identities and backoff, honoring `Retry-After`; an HTTP error can follow acceptance. Compatibility operations split into native chunks, so a large operation can become partially visible before completion.

Monitor disk space as well as backlog: pending limits exclude retained receipts, raw streams, images, and SQLite overhead. `--workers` controls HTTP workers. Internal queue/capacity settings are defined in [src/config.rs](../src/config.rs); `NSET_INGEST_PAUSED=true` deliberately stops projection and should be used only for maintenance or recovery testing.
