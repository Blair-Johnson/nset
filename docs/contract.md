# Initial implementation contract

This document coordinates independent backend, frontend, numerical, and SDK work.
This is a new API inspired by familiar trackers, NOT MLflow/wandb wire compatibility.

## Deployment and auth

One Rust binary `nset` serves embedded `web/dist` and /api. CLI: --data-dir, --listen (default 127.0.0.1:8080), --token-file OR --token (env NSET_TOKEN), max body size 32 MiB. Require nonempty token, never print it. All /api endpoints including artifact bytes require Authorization: Bearer TOKEN. UI assets public; frontend keeps token in sessionStorage only and sends Authorization on fetch; no URL token. No permissive CORS. localhost defaults; HTTPS via proxy or SSH tunnel remotely.

## Types

All IDs are generated UUID strings; timestamps are integer epoch milliseconds; steps nonnegative JS-safe integers (<=9007199254740991); metric values finite f64. Keys/names are nonempty, <=512 UTF-8 bytes. Treat all names as plain text in UI, never HTML. Response lists are wrapped objects.

Experiment: {id,name,created_at}
Run: {id,experiment_id,name,status,params,tags,created_at,updated_at}; params/tags JSON objects; status running|finished|failed.
Metric: {seq,key,step,timestamp,value}; seq globally increasing SQLite integer.
Image: {id,run_id,key,step,timestamp,content_type,byte_length}; byte endpoint separately.
Errors: non-2xx {error: string}; database internals only server log.

## HTTP API

GET /api/health -> {status:"ok"}
GET /api/experiments -> {experiments:[Experiment]}
POST /api/experiments {name} -> Experiment (201); duplicate name returns existing experiment (200).
GET /api/runs?experiment_id=ID -> {runs:[Run]} (newest first)
POST /api/runs {experiment_id,name,params?:{},tags?:{}} -> Run (201)
GET /api/runs/{id} -> Run
PATCH /api/runs/{id} {status?,params?,tags?} -> Run (merge objects)
POST /api/runs/{id}/metrics {metrics:[{key,step,value,timestamp?}]} -> {inserted:N}; transaction, max 10000 rows/request, reject entire invalid batch.
GET /api/runs/{id}/metric-keys -> {keys:[string]}
GET /api/runs/{id}/metrics?key=KEY&after=SEQ&snapshot=SEQ&limit=N -> {points:[Metric],next_after:integer|null,snapshot:integer,total:integer}
Metrics ordered by seq; first page captures max seq for this run/key, all subsequent pages include returned snapshot and after. Default limit 10000 max 50000. Count total is snapshot-bound. No downsampling, every observation available; empty stream supported. Incremental UI refresh can reload snapshot initially. Index run_id,key,seq.
POST /api/runs/{id}/images?key=KEY&step=N&timestamp=MS -> Image (201); raw PNG/JPEG/WebP bytes with matching Content-Type, reject SVG/HTML; unique file paths server-generated. Body limit applies. Validate image header and file/index consistency.
GET /api/runs/{id}/images?key=KEY -> {images:[Image]} ordered step,timestamp,id; omitting key returns all image metadata for run.
GET /api/images/{id}/content -> authenticated image bytes, correct Content-Type, no-sniff, private cache.

## Frontend

Vite + TypeScript, uPlot + OpenSeadragon bundled locally (no runtime CDN), lightweight native DOM, no React necessary. npm build yields web/dist; Rust embeds via rust-embed. Run list with experiment filter/search/status/params and multi-select; metric selector and tabbed timeseries/images/config views. UI stores non-secret view config locally, export/import JSON. Session token login field, explicit logout. Render names safely.

Full metric pages fetched to completion before curves and readouts become authoritative; visible loading and point counts, cancellation/stale-response guards. No implicit point cap or sampling. Full-resolution raw points retained independently from plot viewport. Unequal run logging steps aligned for drawing (union x with interpolation or null semantics explicit), never nearest-index cursor values.

Pinned numeric x cursors A/B (click plot to set active cursor, numeric editing) with each run's interpolated values and deltas; horizontal y threshold lists ALL crossings and plateau intervals, not just first hit. Explicit linear/PCHIP interpolation, no extrapolation. Smoothing off default; EMA computed on full ordered data before display, labeled per-observation alpha. Numeric queries always use the same transformed series independent of zoom, chart width, or log scale. Raw observations distinguished from interpolated curve. Do not silently drop nonpositive log samples: warning and explicit display-only exclusion.

Configuration first-class: x/y linear/log/asinh scales; axis ranges and labels, time/step x; line/point/area styles, stroke width, dash, point size, stepped/linear/spline display paths with caveats when display vs numerical interpolation differ; grid, ticks, legend, cursor/drag zoom, dimensions, independent per-run styles/visibility; reset/export/import presets. Advanced safe JSON uPlot options deep merged with defaults; reject __proto__/constructor/prototype recursively, preserve required data/cursor hooks, no eval. Named path/formatter registry for function-valued settings. Document unsupported executable callbacks plainly. Inspector invariants cannot be bypassed by arbitrary data, hooks, scales that falsify readouts; report protected overrides, do not silently ignore them.

Image pane uses OpenSeadragon image tile source and preserveViewport, viewer enlarged/fullscreen, timeline slider + previous/next + play/pause, keyboard stepping, visible run/key/step/timestamp, fixed pan/zoom across frames, reset view explicit. Fetch image bytes with bearer token to Blob URL; bounded prefetch/cache, revoke URLs when done, latest-request-wins. Images remain native resolution; no server recompression. Include viewer controls rotation/flip where practical. Initial version can view one run/key at a time; comparisons later.

## Numerical module interface (web/src/math.ts)

Export type Point = {seq:number,step:number,timestamp:number,value:number}; type XY = [number,number]; type Interpolation = 'linear'|'pchip'.
canonicalize(points: Point[], axis: 'step'|'timestamp'): XY[] sorts ascending x, duplicate x uses largest seq (document this policy).
ema(points: XY[], alpha: number): XY[] alpha in (0,1], independent of viewport.
makeInterpolator(points: XY[], kind: Interpolation): {at(x:number):number|null; crossings(y:number):{points:number[],plateaus:[number,number][]}}. Exact samples honored; no extrapolation; robust singleton/empty series; endpoint dedup and contiguous plateaus merged. PCHIP uses shape-preserving derivatives and bracketed threshold root solving per segment.
Frontend may also export/use sampleCurve(points, interpolator, samplesPerSegment) if necessary, but raw data must remain independent. Numerical module owns numerical readouts, not uPlot cursor index.

## Ownership

Backend agent: Cargo.toml, src/**, backend unit/integration tests, optional build.rs. No pixi or web edits.
Frontend agent: web/** EXCEPT web/src/math.ts and web/src/math.test.ts; own package.json/config/style/components/browser test integration.
Numerics agent: web/src/math.ts and web/src/math.test.ts only (Node built-in tests via tsx); unit tests thorough.
Parent: pixi.toml/lock, docs, README, Python client/demo/smoke tests, integration, review.
