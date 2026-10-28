# Scalar metric read policies

`GET /api/runs/{runId}/metrics?key={key}` accepts an optional `policy` query
parameter. Each stream in `POST /api/metrics/tail` accepts the same optional
`policy` JSON field (not a top-level field).

- `all` (the default): return every stored observation, including repeated steps.
- `latest-per-step`: for each `(runId, key, step)`, return the observation with the
  greatest immutable server `seq` at or below the requested `snapshot`.
  Client timestamps, step order, and values do not determine the winner.

Both policies return points in ascending `seq` order. `after` is an exclusive
sequence cursor, not a step or offset. Pin the returned `snapshot` while paging;
a newer write cannot replace a winner in an older snapshot. History `total`
counts the selected projection within the entire snapshot, before `after` and
`limit` are applied. Tail responses remain count-free.

After finishing a snapshot, tail from its high-water sequence without supplying
`snapshot` to see new writes, including replacements for older steps. Merge
`latest-per-step` points by step. Several writes to one step between polls may
produce only the latest winner; use `all` to read every observation. Reset local
projection state when switching policies.

Unknown policy literals are rejected (history: HTTP 400; tail JSON: HTTP 422).
An omitted policy means `all`; explicit JSON `null` is invalid. Existing limits,
stream validation, response shapes, and high-water semantics are unchanged.
Policies do not alter stored history, catalog counts, write behavior, or durable
retry receipts: retrying a batch does not allocate another metric sequence.
