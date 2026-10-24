# Durable ingestion and concurrency

The synchronous native `POST /api/runs/{id}/metrics` endpoint still commits metrics before responding. It is not idempotent: losing its response leaves the caller uncertain whether a write committed. The new `PUT /api/runs/{id}/ingest/{batch_id}` endpoint instead commits the batch to a separate durable journal and returns HTTP 202. Query visibility follows asynchronously. A pending receipt is accepted data, not a failed write.

Send the usual `{"metrics":[...]}` body with 1–10,000 observations and a batch ID of 1–128 ASCII letters, digits, dots, underscores or hyphens. IDs are scoped to a run. Retrying the same ID and canonical payload returns its original acceptance metadata; reusing the ID for different data returns 409. `GET` on the same path returns the receipt with `state` equal to `pending` or `applied`, the observation count in `accepted`, and millisecond `accepted_at`. Omitted observation timestamps resolve to that original acceptance time. Native numeric validation remains in force; this is not a mechanism for submitting non-finite values or negative steps.

The journal uses SQLite WAL with FULL synchronization. The projector commits observations and a replay receipt in one query-database transaction before marking the journal batch applied. Restart between these commits replays without inserting the observations twice. A successful response depends on storage synchronization succeeding; this cannot guarantee survival of defective storage hardware or an inconsistent backup.

## Producer retention

Keep data locally until a durable receipt is received. Admission saturation, full pending capacity and storage failures return errors rather than evicting accepted batches. Retry temporary failures with the same batch ID and payload, using backoff. Authentication, validation and conflicting-ID failures require correction, not endless blind retries. Keep timestamp omission unchanged on retries; when timestamps are explicit, resend their original values.

The optional native `Client.durable_outbox(path)` writes batches to a local SQLite spool before sending them. `enqueue` returns a stable batch ID after the local commit. `flush` removes rows only after matching durable receipts, retains failed rows, and raises on the first failed delivery. `start()` enables bounded background delivery; context entry does not start it. `close()` stops workers without implicitly draining or discarding pending rows. Reopen the same spool and destination to resume after a process restart. Spools contain plaintext observations but no persisted token; protect their directory.

```python
with client.durable_outbox("training-outbox.sqlite3") as outbox:
    outbox.enqueue(run.id, [{"key": "loss", "step": 100, "value": 0.23}])
    outbox.flush()
```

A local enqueue acknowledgement and a server receipt describe different durability boundaries. The server cannot preserve data that never reached it; an application that discards data after a failed HTTP request can still lose that data. Official SDK adapters have their own retry and local-buffer behavior, described separately in `docs/client-compatibility.md`.

## Capacity and threads

The server uses a multithreaded Tokio runtime, dedicated SQLite read actors, one query writer, one journal intake worker and one projector. Increasing HTTP concurrency does not create additional SQLite writers. Tune limits with representative batch sizes and reader traffic; more threads can increase contention instead of throughput.

```sh
./target/release/nset --data-dir ./data --token-file ./access-token \
  --http-workers 4 --read-workers 4 --db-queue-capacity 128 \
  --write-concurrency 16 --image-concurrency 2 \
  --ingest-queue-capacity 128 --ingest-max-pending-bytes 536870912 \
  --ingest-max-pending-batches 20000 --ingest-poll-interval-ms 100
```

Defaults are available CPU parallelism capped at 32 HTTP workers, two readers, 64 queued jobs per DB actor, eight admitted HTTP writes, two image handlers, 64 journal intake jobs, 256 MiB of pending journal payload, 10,000 pending batches and a 100 ms idle projection interval. Every flag also accepts its uppercase `NSET_` environment form, with hyphens replaced by underscores. Invalid limits are rejected before databases are opened. `--ingest-paused` accepts journal batches but suspends projection for maintenance or recovery testing; do not leave it enabled unintentionally.

## Recovery and operations

Authenticated `GET /api/ingest/status` exposes pending batches, pending payload bytes and a sanitized last error. A damaged or unprojectable entry remains pending and blocks subsequent projection rather than being skipped. Investigate the underlying storage/schema problem and preserve both databases; there is no discard endpoint. After restarting without pause, valid pending batches resume automatically.

Pending-byte limits do not bound total disk use: SQLite overhead, WALs, free pages and retained applied-batch receipts also occupy storage. Receipt metadata is retained to preserve replay identity. Monitor disk space as well as queue depth. Socket timeouts in the standard-library client are not absolute wall-clock deadlines, so a stalled DNS lookup or trickling peer can delay shutdown.

Back up the complete native data directory with the service stopped, including the query database, ingest journal and image files. Do not restore one database to a different point in time than the other. Include gateway metadata/artifacts and undelivered producer spools when backing up a compatibility deployment. Remote clients should use HTTP over TLS or a tunnel; SQLite files belong on local storage, not a shared network filesystem.

`scripts/benchmark_durable.py` measures local spool time, server acceptance time, query-visibility time, overload retries and exact sentinel readback with configurable clients and worker counts. It is a closed-loop fresh-database benchmark, not evidence of unlimited capacity or an open-loop production SLA.
