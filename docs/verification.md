# Verification record

## Original baseline (before UX redesign)

The following r23 results describe the original workbench, not the current dashboard redesign. New redesign evidence is recorded separately below.

Full integrated acceptance passed in rx r23 against source commit `780d988747346cb3d91b43d849cfd3b6a4181f95`, exit 0 in 78.37 seconds. The command was `CARGO_TARGET_DIR="$PWD/target" rx run -t verification,acceptance bash scripts/verify.sh` from the integration worktree. Later delivery changes only update documentation.

The successful run includes 196 frontend/numerical/configuration tests, 25 Rust tests, strict Clippy and Rust formatting, TypeScript and production/release builds, 11 real HTTP/client tests, 11 Chromium fixtures, the real-server browser acceptance scenario with PNG-pixel assertions, and both 100,000-point throughput probes. No tests were skipped. Rx r22 had passed the first stages but stopped on a new test's use of visibility-dependent `innerText`; comparing stable DOM text repaired that assertion. Runtime rejection now demonstrably preserves the active chart, readouts and saved settings.

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

The final r23 run measured the same 100,000 observations at 4.807 seconds ingestion (about 20,801 observations/second) and 0.228 seconds complete retrieval. The variation from r19 is retained rather than presenting the faster run as guaranteed performance. The final binary SHA-256 is `e20a7aaf34563b1180f14c07784ef374d56f226f03ac2c829dfdad4fb13d4179`.

A separate real-browser probe in r23 loaded and rendered one unsampled 100,000-point series in 251.87 ms and switched it to PCHIP in 210.37 ms. The pinned linear query matched the known interpolated value; no uncaught page errors occurred. Chromium reported approximately 76.6 MB used JavaScript heap (a coarse browser estimate, not total process/GPU memory). Timings include automated interaction, HTTP and analysis work and are single local observations; this is not a concurrent-user or million-point capacity claim.

## Reproduce

```sh
pixi install --locked
pixi run web-install
bash scripts/verify.sh
```

The full script builds production frontend assets, runs numerical/frontend tests, Rust tests and Clippy, builds the release executable, then runs real HTTP tests, fixture-browser tests, real-server browser tests, an HTTP throughput probe, and a 100,000-point dense-browser probe. `scripts/browser_verify.py` creates an isolated temporary server and known-answer dataset; it does not alter the preview database.

Recorded commands and snapshots can be inspected with `rx show r23` and `rx tail r23`. Final screenshots are retained at `../not-shitty-experiment-tracker-worktrees/.rx-worktrees/r23/artifacts/screenshots/` relative to the main repository. They include timeseries, log scales, configuration, timestamp axes, image scrubbing, preserved image zoom, fullscreen timeline controls, narrow layout, and `dense-100k.png`. Fixture captures are in the same run's `web/test-results/`. Logs live in `.git/rx/runs/r23/`. These are local ignored artifacts, not embedded or committed source files.

The final pixel inspection counted 1,448 cyan and 1,369 violet plot pixels with cursor overlays cleared, and 6,176 gold plus 260,938 blue image pixels. Spatial thumbnails showed the expected peaked curve, flat-then-rising comparison curve, and image feature. These content checks complement numerical assertions and camera/layout checks; they do not prove every cosmetic option looks correct.

## Deliberate limits

The application is a single-token local-first tool, not a multi-tenant service. Use HTTPS or a secure tunnel remotely, and keep SQLite on a local filesystem. Browser histories are complete but held in memory; huge run sets remain bounded by browser resources. The image cache bounds compressed blobs, not all decoded CPU/GPU memory. Image playback is load-completion paced, and one run/key is viewed at a time.

Saved plot configurations do not execute arbitrary JavaScript hooks/plugins. The documented safe option surface and named adapters preserve inspector invariants. Non-matched cosmetic paths are distinguished from the numerical interpolant. Crash recovery can leave unindexed image files between file persistence and database commit; no retention/orphan collector is implemented. Power-loss fault injection and non-Unix directory durability were not tested.

## Dashboard redesign verification

The redesign uses locally inspected primary references: MLflow frontend commit `1795b4d7cf870078174a90fe955fab8cf5317cd2` and W&B documentation commit `86eefc342c347f15ce6a4cda3114e9daeaccd403`. The findings and independent implementation decisions are in `docs/ux-survey.md`. No upstream application code was copied. The requested dark appearance supersedes the initial light visual specification without changing the experiment/run/dashboard workflow.

Component work was implemented and committed in separate Git worktrees before integration. Catalog tests cover authenticated metadata discovery and indexed query plans; workspace tests cover identity, persistence validation and source resolution; navigation tests cover linear/nonlinear/reversed scales, pointer-anchored zoom and cursor invariance; card/editor tests cover independent image viewers, deferred loading, cancellation, full-history previews and draft isolation.

The first integrated run, r39, passed 37 browser scenarios but exposed a saved-view completion/reload race. Dialog submission now resolves before navigation, and saved-view edits validate and persist transactionally. Regression coverage also exercises storage-quota failures with an intact editor draft, unique IDs when restoring edited automatic charts, keyboard focus, and preserving plot instances/cursors/zoom across run-table navigation. The focused r41 run passed 231 unit tests and eight shell journeys. Accessibility worker r40 passed 25 browser scenarios, including close-hook ordering and keyboard selection through rerenders.

The real-server r43 scenario passed tables, mixed namespace cards, interpolated A/B values, all crossings/plateaus, pan/zoom/fit/keyboard invariance, contextual log/PCHIP/EMA editing, canceled drafts, unaffected neighboring plots, explicit cross-experiment sources, named view reload/import/export, image camera preservation, maximized timelines, independent image cards, narrow layout and credential cleanup. Its PNG decoder measured 764 blue and 701 violet curve pixels, plus 2,914 gold and 81,100 blue image pixels. Spatial thumbnails reproduced the known peaked/flat-then-rising curves and image feature. This pass predates the final dark palette; final acceptance must repeat the pixel checks against that palette.

Live review opened the actual embedded app, navigated its tables and mixed dashboard, inspected layout geometry and accessibility text, and captured browser screenshots. The browser-tool channel omits image contents here, so this is not a claim of unrestricted human visual inspection: retained PNGs, decoded content pixels, computed styles, contrast checks and live interaction provide the visual evidence. Desktop layout used two columns with scalar and image cards in the same namespace; a 500-pixel live viewport had no horizontal overflow. Automated narrower captures are retained separately.

The ten extended shell tests passed in r44, including explicit-series isolation and scroll restoration on a long dashboard. That command then failed because the parent invoked a nonexistent `benchmark.py --browser` option; no application failure occurred. The corrected dedicated browser probe passed in r45: a complete 100,000-point chart loaded/rendered in 325.39 ms, and contextual PCHIP preview/apply took 831.72 ms. The displayed interpolated query was 1.00692 and matched the known value within the displayed six-significant-digit precision. Chromium's coarse used-JS-heap estimate was 76.6 MB. The PCHIP timing now includes opening and using the editor and is not directly comparable to the original toolbar-only timing.

The complete integrated pre-theme regression r46 passed all 231 frontend unit tests, TypeScript/production build, and 57 Chromium scenarios. A subsequent live editor review identified that the native preview legend still exposed “raw-derived”; shared labels were simplified and a preview-copy regression added before final acceptance.

Dark-theme branch 55237e6 is integrated. Surfaces use neutral charcoal (#151617 page/canvas, #1e2022 cards, #272a2d raised controls), muted mint accents and bright blue/violet/amber/green curves. The theme covers table/status/hover states, native inputs, menus, editor previews, cursors, error/empty states and maximized image panels. Additional browser checks enforce sampled text contrast ≥4.5:1 and control boundaries ≥3:1, exercise 1440px/390px layouts, preserve custom plot colors and compare decoded image pixels. Final acceptance is in progress; no visual inversion/filter is applied to image content.

Theme worker r54 passed its production build and all 60 browser tests in its branch (before the parent's two extra shell tests). The first merged acceptance r55 stopped on the earlier navigation unit test's hard-coded light axis/grid defaults; expected values were updated to the new dark palette while preserving custom-color precedence assertions.

The follow-up r56 unit stage correctly caught the analogous new-chart color assertion after removing its obsolete hard-coded single-color blue. That test now verifies consistency with the current palette's first color; source identity, no implicit selection, smoothing defaults and user-override checks remain unchanged.

Full dark-dashboard acceptance r57 passed against source `68bbcd1`: 231 frontend unit tests, 62 Chromium scenarios, Rust formatting/tests/Clippy, 11 real HTTP tests, embedded-server UI/pixel journeys and both 100k probes (78.32s). This is the verified dark baseline before the user's terminology refinement. The editor and creation menu now expose explicit Line/Scatter/Area/Step plot choices instead of “Curve”; focused tests check source and interpolation preservation, saved/reopened selection, direct creation and a scatter renderer without connecting paths.

Plot-type verification r58 passed all 237 unit tests and 31 of 32 targeted browser scenarios, including direct scatter creation. The new preview test attempted to dereference its first asynchronous render before one existed; its polling assertion is corrected to wait for that render rather than throw before retrying.
