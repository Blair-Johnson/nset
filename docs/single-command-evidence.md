# Single-command server acceptance

Verified on October 24, 2026 on macOS 15.7.9 arm64. This record concerns the in-process Rust server, not the historical Python gateway.

## Delivered contract

`nset serve --host 127.0.0.1 --port 8080 --token '<YOUR_LONG_RANDOM_TOKEN>' --db-path ./nset-data`

One executable and HTTP listener serve the embedded UI, native API, MLflow and W&B. The public options are `--host`, `--port`, `--db-path`, `--token`, `--token-file`, `--workers`, and `--log-level error|warn|info|debug`; root help/version are available. Defaults are loopback, 8080, `./nset-data`, automatic workers capped at 32, and info. `NSET_TOKEN` is an alternative; token and token-file conflict. Removed launch flags and underscore aliases are rejected.

Python serving, proxy, upstream transport and adapter runtime modules, the `compat-serve` task, and obsolete gateway-transport tests were removed. Python remains only a producer/client, optional TensorBoard collector, and SDK-test dependency. Native images and the existing UI are unchanged.

Compatibility metadata shares `nset.sqlite3`; durable scalar intake uses `ingest.sqlite3`. Native images and the ownership lock share that root. Atomic native-run/mapping creation, persistent pending operations, stable chunk IDs, exact finite-f64 round trips, per-run sequencing and explicit unsupported-upload failures are covered. After intake, a disconnected/timed-out HTTP waiter does not cancel the admitted operation or release its locks early. Shutdown drains admitted work and joins database workers before releasing ownership.

## Source and execution records

Runtime implementation: `c73b495`; Python-runtime retirement and current documentation: `c0de1cf`. Follow-up commits add a real-process active-work shutdown regression (`d937e5d`) and correct an existing browser selector to target the primary cursor delta (`7f01418`), without UI changes. `Cargo.toml`, `Cargo.lock`, `src/` and `web/` are byte-identical between the optimized binary's source `c0de1cf` and `7f01418`.

All runs below are independent verification roots, with no saved result query. `rx show <run>` gives the exact command, immutable snapshot and retained worktree.

| Run / command | Result |
| --- | --- |
| r325 / c325 | Fresh web dependency install, production build, 310 web unit tests passed. |
| r332 / c331 | Format check and strict Clippy (`--all-targets -- -D warnings`) passed; 87 Rust tests and 114 Python tests passed, zero skips and zero ResourceWarnings. |
| r333 / c333 | Fresh UI build, 310 web unit tests, locked optimized Rust build, and all 114 Python tests passed. The overall run failed later on a stale browser selector; it is not an all-green record. |
| r334 / c334 | Corrected browser check, real-process active-work shutdown test, and copied optimized executable smoke passed. CLI and linked-library inspection also passed. |

r332 Python counts: native API 4, benchmark correctness 11, client 2, same-port boundary 15, durable HTTP 4, history 3, native images 2, MLflow 11, outbox 27, standalone 1, TensorBoard 22, W&B 12. MLflow includes three official-SDK cases; W&B includes two official-SDK cases covering init/config/scalars/summary/finish/resume and offline sync repeated twice. r334 adds the direct shutdown test, taking the current Python suite to 115 cases.

The compatibility tests launch the compiled Rust executable directly. They no longer start a Python HTTP server. Protocol/recovery coverage includes exact history and native params, overlapping/repeated batches, kill/restart, pending metadata failure boundaries, 10,001-metric chunking, stream offsets/conflicts and tails, unauthorized requests, shared admission, compressed/decompressed limits, GraphQL argument/response expansion budgets, and nonretryable unsupported uploads. Native journal/image tests remain. A cancellation test blocks SQLite, drops the HTTP waiter, and verifies a conflicting write still observes the original immutable param. A worker-drain test retains ownership while a cancelled caller's accepted job is gated; the direct process test also signals shutdown while such a write is blocked, rejects a second owner, then confirms completion after restart.

SDK environment: Python 3.13.17, MLflow 3.17.2, W&B 0.31.0, TensorBoard 2.21.0. Rust: 1.99.0, through the locked Pixi environment; Cargo commands use `--locked`.

## Standalone optimized binary

The optimized executable is `target/release/nset` in the single-command worktree. SHA-256:

```text
c01ea6c65590c1f0fb37936045115b4933941012b039769e1d81cd634889b2b6
```

After building r333, `web/dist` was renamed away before testing. The smoke copies the executable to a temporary directory outside the checkout and launches it with an empty PATH: Python, Node and Pixi are not discoverable there. It serves the UI and both embedded asset files, native API, MLflow metric/history and W&B metric/config/finish workflows on the same disposable port; native params contain the typed W&B config. There is no `web/dist` in that temporary directory and no generic artifact store. r334 repeats this smoke against the same binary. `otool -L` lists only macOS system `libiconv.2.dylib` and `libSystem.B.dylib`.

Browser evidence is retained under the r334 worktree's `artifacts/screenshots`; no UI source was changed. The original failure selected secondary ΔX=5 after the UI began displaying both cursor axes; the corrected assertion checks primary ΔY=1.

## Limits

Only macOS arm64 was built and exercised here. Windows, Linux, macOS x86_64 and cross-platform release packaging were not verified. No binary was published and no download URL is asserted. Main and the existing preview were not modified.

This is the reduced tracking protocol, not either vendor's whole platform. Artifacts and run-file uploads remain unsupported; the normal W&B SDK workflows emit expected unsupported-probe/retry warnings. Do not call the SDK gate warning-free. Explicit SDK `wandb.save`, `Image`, and `Artifact` calls are not separate end-to-end cases; normal SDK workflows and explicit protocol upload rejection are covered, but upload retry counts are not asserted. Pagination is query-bound, not a frozen data snapshot. No prior Python-gateway state migration is provided. TLS termination and production throughput claims are outside this verification.
