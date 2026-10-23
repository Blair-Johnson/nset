# Verification record

## Previous redesigned release (r59)

Full integrated acceptance passed in rx r59 against source `7d6b8de` in 80.74 seconds. It includes 237 frontend/numerical/state tests, 64 Chromium scenarios (including dark-theme contrast and concrete plot presets), production TypeScript/Vite and Rust release builds, Rust formatting/tests/strict Clippy, 11 real HTTP/client tests, the embedded-server dashboard/image/pixel journey and both 100,000-point throughput probes. No tests were skipped. Subsequent delivery commits only update documentation.

The final dense chart loaded/rendered in 300.40 ms, and contextual PCHIP editor/preview/apply took 814.51 ms. HTTP ingestion measured 33,565 observations/second with complete retrieval in 0.221 seconds. These are local single-run observations, not capacity guarantees. The tested executable SHA-256 was `36f04ea50c81ba7913a8697cae6d3c45acd6599dd57f91d9eeb2020f1a6652e0`.

Current screenshots are retained in `../not-shitty-experiment-tracker-worktrees/.rx-worktrees/r59/artifacts/screenshots/` and that run's `web/test-results/`. They cover experiment/run tables, mixed dashboards, contextual editors, cursor readouts, custom comparisons, image timelines/maximization, dense series and narrow dark layouts. Use `rx show r59` and `rx tail r59` for the exact snapshot and command evidence. The chronological record below includes failed attempts and limitations rather than hiding them.

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

## Compact workspace refinement

This refinement applies direct manipulation and information-first layout: routine comparison stays in the run drawer and plots, while editing is contextual. Verification combines numerical/state regressions with real gestures, decoded image/selection pixels and measured layout geometry. Passing component tests alone is not evidence of good overall UX.

The first complete merged run, rx r100 at `055aae1`, passed 271 frontend tests, 28 Rust tests, 11 HTTP/client tests and 143 Chromium scenarios, including delayed image replacement against the authenticated Rust server. It stopped on two viewport contrast scenarios: the global axis selector used a divider border instead of the stronger shared control border. The CSS token was corrected without weakening the contrast requirement. Run r101 then passed all 145 Chromium scenarios, the embedded dashboard journey and both 100,000-point probes, but the new 60-run fullscreen check measured a 741px-high plotting rectangle at a 1000px viewport, below the 750px criterion. The oversized 64px single-line X tick gutter was reduced to 32px; axis-title space and explicit user sizing remain unchanged.

Earlier integration failures are retained. Run r96 exposed invalid image-catalog fixtures, obsolete selectors and a real pin-placement cancellation caused by the inspector changing height mid-drag. The inspector now reserves stable space only when open. Run r97 passed full placement drags, global controls and relative-time crossings; its remaining outdated hover-row assertion was updated for a three-row transient summary with all run values retained in the expandable, scrollable legend. Independent review fixes cover populated mobile previews, style edits after changing axes, keyboard focus through table actions and repeated Undo, and cross-tab run colors without resetting configuration browsing.

Live browser measurement at 1512×857 placed the first namespace at y=126px, the first card at y=164px and the first uPlot at y=244px, compared with card y=321.5px and uPlot y=413.5px in the previous release. The application header is 40px, the dashboard toolbar 36px, the drawer 260px wide, and visible native selects reserve 26–28px for their indicators. There was no horizontal page overflow. These are geometry measurements, not a claim that every screen has fewer controls or that the design has been aesthetically approved.

Browser-tool image payloads are omitted in this environment. Visual evidence therefore comprises decoded PNG content, computed contrast/geometry, live interaction and retained captures, not unrestricted human image inspection. Chromium on macOS is the tested environment. Views and shared run colors remain browser-local; the dedicated run page browses parsed parameters, not raw YAML artifacts. Temporary cursor/zoom state survives in-place resize and run-page navigation but is not exported in saved views.

Run r102 passed all 272 frontend tests and 144 browser scenarios but exposed an ambiguous search locator in the empty-state contrast fixture. It could fill the experiment search while navigation to Runs was still pending. The fixture now waits for the Runs table and targets the run-search field by its accessible name, then waits for the filtered result before sampling contrast.

Run r103 passed all 272 frontend and 145 browser tests, then the real-server journey raced asynchronous view-file import: it accepted the preexisting chart with the same title as completion and attempted to scroll a DOM node being replaced. The journey now waits for the selected view ID to change, not only for its unchanged display name/card title. The application import creates a new identity as intended.

Focused real-server rerun r104 at `e661e4c` passed the dashboard/image/global-controls journey, the 60-run embedded shell, and five repetitions of the corrected navigation/empty-state test. The actual 1440×1000 shell had 32px table rows and first namespace y=126px; the maximized plot rectangle measured 1258×773px, with persisted resized card dimensions 574×402px and no page errors. This is intermediate evidence: subsequent user feedback requires MLflow-style split-pane collapse/reopening, clearer saved-view labeling, top/right A/B cursor labels, resize-scroll preservation, removal of an idle blue selection border and removal of duplicate Charts navigation. The final release record must include those changes rather than presenting r104 as final acceptance.

Parent commit `a3fbda0` hides the zoom-selection overlay unless a meaningful zoom gesture is active, clearing it on release/cancel/pan, and removes the duplicate run-detail Charts action while preserving the attributes browser. Run r108 passed the production frontend build, 272 unit tests and 45 navigation/run-detail/shell browser scenarios, including decoded active-selection pixels and an idle-no-blue-box capture.

Resize worker `37d911c` reproduced the reported scroll jump in r112 on a 24-card full shell: releasing a resize moved scrollY from 5256 to 72 and caused 26 card/section remove/reinsert operations. The fix uses `focus({preventScroll:true})` and index-aware placement that leaves correctly ordered nodes connected. Run r121 passed the production frontend build, 272 unit tests and 34 focused browser scenarios. Frame-level measurements keep scrollY at 5256 through ordinary pointer/keyboard commits and cancellations, with zero node moves and preserved canvas, navigation, data and pin identity. Error-banner anchoring and natural bottom-of-document clamping are allowed; no delayed scroll restoration is used.

Integrated cursor/drawer acceptance r131 at `3a56d79` passed production TypeScript/Vite, all 272 frontend units and 69 browser scenarios. It combines the MLflow-style edge divider, click-confirmed A→B placement while drag zoom/pan remains available, primary signed cursor-position deltas, top/right A/B badges, and frame-level resize-scroll preservation. This predates the forthcoming fold/card-composition and within-section reordering changes and is not final release acceptance.

Parent log-label correction `dbeaadc` preserves uPlot's null filtered tick labels as empty strings instead of drawing em dashes. Rx r133 passed 274 frontend units, production build and eight actual-uPlot/section-reorder browser tests, including retained log-learning-rate rendering and section header geometry. The full embedded-server dashboard journey passed in r134 with the cursor-position delta assertion updated; image and curve pixels, global coordinates/smoothing and saved-view roundtrips remained correct. The isolated review server on port 8081 was restarted with this build; main delivery is still pending card composition and the new cursor shortcut.

Card composition integrated as `e418048` from worker `14ad611`: r146 passed build, 272 units and 172 browser cases (one environment-gated image-server skip, covered by full acceptance). It recorded fixed card/sibling positions through 26 grow/shrink preview frames and reflow only after release, with scrollY=2664 unchanged. Normal/open-fold drawing rectangle remained 434×261; a 1100×1170 card used 954×1011 for data, versus the user's screenshot's roughly 267px plot height. Parent review adds stable fullscreen scrollbar gutter and preservation of the open coordinate editor across mode changes. C shortcut integration r149 passed 277 units/build and 38 browser cases after correcting an overly broad button-focus exclusion; typed fields remain protected. Complete merged release acceptance remains pending.

Integrated release attempt `r150` at `5cec4ff` passed 277 frontend unit tests, 28 Rust tests, 11 Python/HTTP tests and 188 of 190 Chromium scenarios, including the real-image path. The two failures were test expectations: a forced 16-pixel scrollbar on a browser using overlay scrollbars, and a second click that closed the now-correctly-retained coordinate editor. Commit `721b81f` measures native scrollbar allocation independently, still requires unchanged plot dimensions through three fold cycles, and explicitly checks that switching cursor orientation retains the open editor. Full acceptance is rerunning; this paragraph does not record a successful release.
