# Logging and delivery

Start the server as shown in the [README](../README.md). All clients use its address and shared access token. Replace loopback addresses below for remote training, and protect credentials with HTTPS or a secure tunnel.

## Native Python client

Install `pip install ./client` from the checkout in a Python 3.10+ training environment. The [README example](../README.md#log-data) creates an experiment and run:

```python
run.log_metrics({"train/loss": 0.23, "train/accuracy": 0.94}, step=100)
run.log_image("train/prediction", "prediction.png", step=100)
```

Scalar logging is durable by default. `log_metrics` and `log_batch` return `{"accepted": count}` after a local commit. Delivery runs automatically with retry/backoff. Lost responses and restarts reuse the same stored batch, without duplicate observations. Calling a logging method again creates new observations; do not resubmit successful calls.

`run.flush()` waits for its queued scalars to reach durable server storage; `client.flush()` covers all queued runs for that destination. Query visibility follows asynchronously. `client.metric_history(run.id, "train/loss")` reads the complete currently visible history.

`run.finish()` and run-context exit flush before marking the run finished (or failed if training raises). Delivery timeout raises `DeliveryTimeoutError`; permanent HTTP rejection raises `DeliveryError`. Data remains local and the run is not marked complete. An existing training exception stays primary, with a failure note. A subsequent status-request error can leave status uncertain, but scalars are already accepted.

Use `with Client(...) as client:` or `client.close()` to drain and stop delivery. The default wait is 30 seconds; change it with `Client(..., flush_timeout=60)` or `timeout=60` on `flush`, `finish`, or `close` (0–300 seconds). Timed-out close does not wait indefinitely on network workers. Local filesystem operations still depend on the OS and disk.

### Recovery and limits

Creating a `Client` with the same server URL automatically resumes retained batches from previous clients/processes. Correct authentication or validation/conflict problems before reopening. Completion is not queued: retry `finish()` on the existing run after recovery. Create a fresh client after a fork.

`client.spool_path` locates the private SQLite spool, separated by server URL under:

- macOS: `~/Library/Application Support/nset/outbox`
- Linux: `$XDG_STATE_HOME/nset/outbox`, defaulting to `~/.local/state/nset/outbox`
- Windows: `%LOCALAPPDATA%\nset\outbox`

Tokens are never stored; observations and destination URLs are plaintext. Retain the spool and its SQLite sidecars on local storage that honors synchronization. Losing or deleting them can lose undelivered data. Capacity is 10,000 pending batches or 256 MiB of payloads, plus SQLite overhead. Capacity and disk-write failures raise rather than evict data or report acceptance.

- `run.log_batch(rows)` accepts 1–10,000 dictionaries with `key`, `step`, `value`, and optional `timestamp`. Values must be finite; keys are 1–512 UTF-8 bytes; request bodies are at most 32 MiB.
- Steps and timestamps are integers from 0 through 9,007,199,254,740,991. Timestamps are Unix epoch milliseconds. Omission uses the server's first acceptance time, preserved on retries.
- Experiment/run creation requires a reachable server. Images remain synchronous uploads without the scalar retry/spool guarantee. PNG, JPEG, and WebP originals are retained after acceptance; limits are 32 MiB per request, 32,768 pixels per dimension, and 256 MiB of decoder allocation.

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

Keep the `--db-path` directory on local storage. Stop the server before backing up the whole directory together: `nset.sqlite3`, `ingest.sqlite3`, native images, `nset.lock`, and any SQLite WAL/SHM sidecars. Restore them from the same backup. Native client spools and W&B offline runs also need retention until delivery is confirmed.

Authenticated `GET /api/ingest/status` reports pending batches/bytes and the last projection error. A damaged batch remains pending and blocks later projection; preserve the databases while investigating. Capacity errors retain accepted batches. Retry temporary delivery failures with stable identities and backoff, honoring `Retry-After`; an HTTP error can follow acceptance. Compatibility operations split into native chunks, so a large operation can become partially visible before completion.

Monitor disk space as well as backlog: pending limits exclude retained receipts, raw streams, images, and SQLite overhead. `--workers` controls HTTP workers. Internal queue/capacity settings are defined in [src/config.rs](../src/config.rs); `NSET_INGEST_PAUSED=true` deliberately stops projection and should be used only for maintenance or recovery testing.
