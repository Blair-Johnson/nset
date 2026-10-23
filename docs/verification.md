# Verification record

Integration acceptance is in progress; this file will be updated after the final plot-configuration merge and all-source verification run.

## Environment and scope

Tests ran locally on macOS 15.7.9 arm64 using the locked Pixi environment: Rust 1.99.0, Node 22.23.4, and Python 3.13.17. Chromium is the tested browser. Other operating systems and browsers have not been validated here. All demo and benchmark data are synthetic, and no prior experiment data was imported.

## Component evidence

The numerical engine passed 27 unit tests and strict TypeScript validation in rx r3. Tests include exact knots, irregular spacing, duplicate x policy, linear/PCHIP evaluation, shape preservation, all threshold crossings, plateaus, invalid input, and floating-point edge cases.

The adaptive renderer and numerical engine passed 45 combined tests in rx r13. The rendering tests probe non-vertex screen-space error on log/asinh/reversed axes, clipping and gaps, budget exhaustion, unchanged numerical queries, and retention of more than 10,000 original knots. Adaptive display sampling is an approximation with an explicit work limit, not a proof of arbitrary-function fidelity.

The hardened Rust backend passed 24 tests, formatting, compilation, and strict Clippy in rx r9. Coverage includes authentication, snapshot pagination with more than 50,000 observations, concurrent readers/writers, transaction rollback, schema-version rejection without mutation, PNG/JPEG/WebP validation and unchanged byte retrieval, failure cleanup, security headers, and graceful SIGTERM exit. An additional image-timestamp regression was added during integration.

The initial frontend passed 70 combined unit tests and five Chromium API-fixture scenarios in rx r14. Those scenarios cover complete pagination, configuration validation, malicious names, saved views, image navigation, delayed-image races, mobile layout, and zoom-invariant readouts. The expanded configuration/matched-path component passed 194 unit tests and ten Chromium fixtures in rx r21. It covers nonlinear projections, zoom/resize rebuilding, range/marker adapters, paired legend visibility, short-drag suppression, singleton display and rejected-chart preservation. Parent integration adds distinct timestamp tick defaults and transactional application state, with regression tests.

## Real-server integration

The first real TCP run, rx r15, caught that image upload timestamps were required despite the client/API contract permitting omission. The server now defaults missing timestamps, still rejects invalid supplied timestamps, and has a direct Rust regression. The repaired real TCP suite passed all 11 tests in rx r16, including 10,023-point retrieval, eight concurrent logging clients, restart persistence, authentication and unchanged image bytes.

The first real-server browser pass caught a stale completion label during saved-view restoration. Loading invalidation now clears that label, and tests wait for the actual restored controls. Rx r18 passed cursor values, both threshold crossings and plateaus, log/zoom/resize invariance, PCHIP values, saved JSON roundtrips, protected-option rejection, image-camera preservation, keyboard/playback navigation, native-pixel controls, narrow layout, and token removal at logout.

The screenshot tests inspect actual PNG pixels using Chromium's decoder, not just DOM presence. With cursor overlays cleared, both curve strokes were present in the plot area. The image viewport contained the expected colored image features. Camera zoom and center were compared before and after a frame change. Screenshots were also opened in Chrome and captured through the browser tool for inspection. This is not a claim of exhaustive manual aesthetic or cross-browser review.

A live fullscreen check found that fullscreening only the OpenSeadragon canvas hid the timeline. The image inspector now requests fullscreen as a whole, keeping playback, frame selection, and exit controls visible. A dedicated real-browser regression is included, along with timestamp-axis and full-series EMA checks.

## Performance observation

Rx r19 ingested 100,000 scalar observations in 1,000-point batches over loopback HTTP using the release executable. It measured 2.490 seconds for ingestion (about 40,165 observations/second) and 0.220 seconds for complete retrieval. This includes the synchronous Python client and JSON/HTTP overhead; it is one local observation, not a general throughput guarantee or a browser-rendering benchmark. The run records the executable SHA-256 and environment fingerprint.

## Reproduce

```sh
pixi install --locked
pixi run web-install
bash scripts/verify.sh
```

The full script builds production frontend assets, runs numerical/frontend tests, Rust tests and Clippy, builds the release executable, then runs real HTTP tests, fixture-browser tests, real-server browser tests, and a throughput probe. `scripts/browser_verify.py` creates an isolated temporary server and known-answer dataset; it does not alter the preview database.

Recorded commands and snapshots can be inspected with `rx show RUN` and `rx tail RUN`. The initial real-browser screenshots are retained under `../.rx-worktrees/r18/artifacts/screenshots/` relative to the integration worktree; fixture screenshots are under `../.rx-worktrees/r14/web/test-results/`. Each final run retains its own artifacts rather than overwriting the earlier evidence.

## Deliberate limits

The application is a single-token local-first tool, not a multi-tenant service. Use HTTPS or a secure tunnel remotely, and keep SQLite on a local filesystem. Browser histories are complete but held in memory; huge run sets remain bounded by browser resources. The image cache bounds compressed blobs, not all decoded CPU/GPU memory. Image playback is load-completion paced, and one run/key is viewed at a time.

Saved plot configurations do not execute arbitrary JavaScript hooks/plugins. The documented safe option surface and named adapters preserve inspector invariants. Non-matched cosmetic paths are distinguished from the numerical interpolant. Crash recovery can leave unindexed image files between file persistence and database commit; no retention/orphan collector is implemented. Power-loss fault injection and non-Unix directory durability were not tested.
