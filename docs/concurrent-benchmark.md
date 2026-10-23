# Concurrent ingestion benchmark (first milestone)

`scripts/benchmark.py` starts one fresh temporary server and exercises its HTTP API.
Defaults remain **100,000 total points, batches of 1,000, one sequential producer,
one run, one experiment, no concurrent readers**. Existing final-event throughput,
timing, point-count, binary-hash and environment fields remain available. Scalar
values now use exactly representable deterministic sentinels instead of reciprocal
values, and timestamps are explicit so readback can verify every field. These
payload changes mean historical reciprocal-value timings are not equivalent
baselines.

## Run it

The existing task builds the release binary before running:

```sh
pixi run benchmark --points 100000 --batch-size 1000
```

When a coordinator has already built a binary, bypass that build-dependent task.
Use an absolute binary path, especially under rx's detached execution worktree:

```sh
NSET_BINARY=/absolute/path/to/nset rx run -t ingestion,benchmark \
  -c '8 producers sharing one run; 100k total; batch=1000; catalog/history readers=1/1' \
  pixi run python scripts/benchmark.py --points 100000 --batch-size 1000 \
  --concurrency 8 --runs 1 --experiments 1 \
  --catalog-readers 1 --history-readers 1 --reader-interval 0.1
```

Use `--concurrency 8 --runs 8 --experiments 8` for independent runs/experiments.
Producer `p` writes run `p % runs`; run `r` belongs to experiment `r % experiments`.
`--points` is the **total**, not a per-producer multiplier. Producers own disjoint
strided steps, and each completes one request before sending the next. Runs cannot
exceed producers, and experiments cannot exceed runs.

`--keys` spreads observations deterministically over `loss`, `loss_1`, etc.
Readers start with producers and stop when writes finish (or their request budget
is exhausted). Each history reader samples one first page, rotating through
run/key pairs that the workload writes; those may still be empty at startup.
It does not continuously fetch full histories. Each reader pauses at least
`--reader-interval` seconds **after** every response, so the configured interval is
not a fixed offered rate. `--max-reader-requests` caps requests per reader.

The CLI limits total points to 1,000,000, producers to 128, concurrent readers to 16,
keys to 32, write batches to 10,000, history pages to 50,000, and each reader to
10,000 requests. `--timeout` applies to measured HTTP operations; it is a socket
timeout, not an absolute whole-run deadline. The fixture's readiness checks retain
their existing timeout behavior. `--help` lists all defaults.

Pure helper tests require no binary or backend:

```sh
pixi run python -m unittest discover -s tests -p test_benchmark.py -v
```

## Read the events

Each invocation emits JSON `kind=config` and `kind=final` records with
`schema_version=1`, resolved options, binary SHA-256, and environment details.
The final event reports `attempted_points`, `acknowledged_points`, and `points`
(exactly verified rows), together with attempted/acknowledged/failed request totals.
It includes explicit `http_503`, `http_500`, `timeouts`, error-category counts and
bounded examples. Per-operation request counts and p50/p95/p99 latencies accompany
aggregate `write_latency` and `request_latency`, in milliseconds. Producer/run
assignments, actual IDs, invalid acknowledgments, missing acknowledged points,
integrity errors and a `success` flag make the correctness outcome inspectable.

Percentiles use nearest rank over **all attempts**, including failures; empty
samples yield JSON null. Aggregate request latency includes setup and final
verification; per-operation fields separate those from load traffic. Request
timing includes Python JSON serialization, HTTP/network work and JSON decoding,
but not batch construction. Write throughput is acknowledged points divided by
the producer phase's wall time, including client preparation and thread scheduling;
setup, final verification, and draining in-flight readers are outside that phase.

After writers and concurrent readers finish, verification fetches every configured
run/key, checks key sets and stable pagination metadata, and validates each
acknowledged `(run, key, step, timestamp, value)` exactly. Insertion order need not
match step order. Missing, duplicate, unexpected, or cross-run observations fail.
The check includes empty histories to catch writes that were not acknowledged.

**No write is retried**, including HTTP 503, 500, or timeout. Any request error,
invalid acknowledgment, startup failure, or integrity error produces nonzero exit
status and `success=false`. A timeout/disconnect can still commit at the server;
an unexpected stored row can therefore mean a lost acknowledgment, not necessarily
backend corruption. Failed runs are diagnostic evidence, not successful throughput
measurements. Correctness readback is not a crash/durability test.

## Limits of this milestone

This is closed-loop load: slower replies reduce offered traffic. It does not model
an externally paced arrival process, prove overload capacity, or eliminate
coordinated omission. One local Python process, the GIL, JSON handling, HTTP
connection setup, and shared client/server host resources can limit measured
throughput. There is no warm-up, repetition scheduler, confidence interval,
per-experiment fairness measurement, queue/service/commit timing, RSS/WAL sizing,
image traffic, seeded history, cancellation test, or multi-server contention test.
Concurrent reads are traffic only; exact validation occurs after load stops.
The fresh database and server log are deleted by the fixture on exit. Record the
source snapshot (rx does this), binary hash, machine and storage context when
comparing runs; the printed temporary storage path does not identify disk hardware
or filesystem settings. Do not compare a single run as a regression verdict.
