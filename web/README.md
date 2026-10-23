# Browser workbench

## Run and verify

The browser uses Vite, TypeScript, uPlot, OpenSeadragon, and native DOM. Dependencies are pinned in `package-lock.json`; all assets are bundled locally. Numerical analysis lives in `src/math.ts`; adaptive display tessellation lives in `src/rendering.ts`.

From the repository root:

```sh
pixi install
pixi run npm --prefix web ci
pixi run npm --prefix web run build
pixi run npm --prefix web test
pixi run npm --prefix web run dev
# Optional Chromium fixtures and retained screenshots:
pixi run npm --prefix web exec -- playwright install chromium
pixi run npm --prefix web run test:browser
```

Vite forwards `/api` to `127.0.0.1:8080`. The built application uses same-origin API requests. Enter the server token in the connection dialog; it is kept only in session storage, never URL parameters or saved-view files. Disconnect cancels active requests and clears the token, plotted observations, and image cache. Remote deployments require HTTPS or an SSH tunnel.

## What the plot and inspector mean

Select an experiment, filter by name/parameters/tags/status, and check any number of runs. Every metric page is fetched to a stable snapshot before analysis or curves become authoritative. Progress and failures remain visible; failed comparisons do not display partial results as complete. Refresh captures a new snapshot.

Canonicalization sorts by the selected step or timestamp axis; duplicate x uses the observation with the greatest sequence number. Optional EMA uses a per-observation alpha on that complete canonical sequence. Linear or PCHIP interpolation supplies A/B values, deltas, and **all** threshold crossings and plateau intervals. No extrapolation, nearest-index lookup, viewport sampling, or zoom-dependent analysis is used. Numeric timestamp fields use epoch milliseconds.

Pinned A/B cursors can be entered numerically or placed by clicking the plot with the active pin selected. Drag zoom changes the viewport only. Reset zoom returns to configured ranges. The threshold field drives both the horizontal overlay and the complete intersection table. Blank/out-of-domain values display an em dash. An enabled live hover legend reports the nearest drawing-grid point, not the exact pinned interpolation; a warning identifies this boundary. Legend toggles are temporary display choices; use per-run configuration for persisted visibility.

## Matched rendering

The default **matched** path evaluates the selected interpolator in original data coordinates. Linear interpolation on two linear axes uses uPlot's fast native linear path. PCHIP, and linear interpolation with either log/asinh axis, use an adaptive per-run PathBuilder over the original transformed knots. It projects through the current uPlot scales, targets **0.35 CSS pixels** of polyline error, clips stroke/fill to the viewport, and rebuilds after zoom or resize. No fixed drawing grid is created, and adding comparison runs does not change a run's path at the same viewport and size (automatic range changes can change subdivisions).

The tolerance is an adaptive estimate, not a proof of maximum error: quarter/mid/three-quarter probes use bounded depth (20) and extra-point budget (200,000 per stroke/fill-domain invocation). A visible warning reports depth, precision, budget or invalid-evaluation limits without rerendering the chart. Explicit pixel snapping is cosmetic and can add rounding error; adaptive curves default to unsnapped coordinates unless global/per-run `pxAlign` requests it. Full arrays remain available for ranging and the numerical engine; tessellation never changes smoothing, A/B queries or thresholds. Log-domain exclusions form gaps, never clamped positive observations. Raw markers remain unsmoothed and occur only at observation coordinates. A singleton derived series has a marker even with raw markers off.

## Configuration contract

The form exposes scale types/ranges, labels/formatters, dimensions, grid/ticks/legend/cursor/zoom, palette mode, and default/per-run line, opacity, fill, marker and path controls. With comparison palette enabled, palette colors replace the default color; disable it to use one custom default color. Stable run-ID overrides win over both. Nested marker/path options inherit recursively. Advanced JSON overrides common presentation controls; an advanced scale range replaces built-in min/max as a whole, including null endpoints. Objects merge recursively; **arrays replace**, except the two `axes` positional patches preserve missing axis defaults. Thus `dash:[]` clears a dash and `axes:[{}]` keeps the y axis.

Unknown/protected fields reject before application. Literal JSON is bounded to 256 KiB UTF-8, 20,000 values, 8,192 characters per string/key, 4,096 entries per array, and depth 32. No callbacks, executable strings, prototype keys, DOM objects or URL-valued colors are accepted. Colors are browser-validated literal CSS colors, including transparent/alpha forms, not variables or images.

### Advanced JSON (uPlot 1.6.32)

- `title`: string. `padding`: exactly four numbers 0–160 or null (automatic). `pxAlign`: boolean or number 0–10. `drawOrder`: `["axes","series"]` or reversed. `focus:{alpha:0..1}`. `select:{show:boolean,over:boolean}`; geometry remains internal.
- `scales:{x:{...},y:{...}}`: `dir:1|-1`, `log:2|10`, positive `asinh`, boolean `auto`, and `range:[min,max]` with finite numbers/null, or `range:{min:{pad,soft,mode,hard},max:{pad,soft,mode,hard}}`. Both limit objects are required; their fields are optional. `pad` is 0–10; `mode` is 0,1,2,3; hard/soft bounds are finite. Distribution still comes from the built-in linear/log/asinh selector. Fully fixed tuples default to `auto:false`; explicitly disabling auto requires two tuple values or both hard limits. Trusted adapters support range objects on both aligned x and y. Numeric padding that crosses zero on a log scale uses a positive lower display bound based on the original minimum/base, respecting hard limits; observations are never changed. Invalid/nonfinite effective ranges are errors. All explicit log bounds/splits and fill baselines must be positive.
- `axes:[xPatch,yPatch]` (at most two): `show`, `label`, `font`, `labelFont`, `stroke`, `size`, `gap`, `labelSize`, `labelGap`, `rotate`, `side`, `align`, `alignTo`, `lineGap`, `space`, `incrs`, `splits`, `values`, `grid`, `ticks`, `border`. x sides are 0/top or 2/bottom; y sides 1/right or 3/left. Nonzero rotation is bottom-x only. Alignment values are 1 or 2. `incrs` must be nonempty, positive, strictly increasing; `splits` strictly increasing. `values` is `number|fixed-2|scientific|iso-time`, or a string/number/null array paired with same-length explicit splits. Static labels stay attached to split values and bypass log label filtering. Line objects accept `show,stroke,width,dash,cap`; only ticks also accepts `size`. Caps are `butt|round|square`; dash is a nonnegative numeric array.
- `cursor`: booleans `show,x,y,lock`; `drag:{x,y,dist,setScale,uni}` (`dist`/`uni` 0–1000; null uni disables the constraint); `points:{show,one,size,width,stroke,fill}`; `focus:{prox,bias}`; `hover:{prox,bias,skip}`. Bias is -1,0,1; negative focus proximity disables focus. `points.one` requires nonnegative focus proximity. Hover proximity accepts null or 0–1,000,000; skip is an array of null/finite numbers and always retains the internal undefined exclusion. Marker size is 0–100 and width 0–20. Pin picking suppresses completed short drags using the configured drag distance, even with `setScale:false`.
- `legend`: booleans `show,live,isolate`; `markers:{show,width,stroke,fill,dash}`. Marker width is 0–20. Legend dash is a CSS border style (`solid,dashed,dotted,double,groove,ridge,inset,outset,none,hidden`), **not** a numeric array. Clicking either row toggles its derived/raw run pair. Ctrl/Meta-click isolates/restores pairs; `isolate:true` makes isolation the default click action. Raw markers never become enabled merely through isolation. Cursor lock retains native legend-lock behavior.

### Run style literals

Existing `color,width,dash,points,pointSize,fill,visible,path` remain supported. `fill` is area opacity, not a color. Additional fields: `cap`, `alpha` (whole-series opacity 0–1), `pxAlign` (boolean or 0–10), independent `fillColor`, finite `fillTo`, and boolean `auto` (auto-range participation only). The default fill baseline is zero for linear/asinh and the visible positive lower bound for log; explicit log baselines must be positive. Baselines outside the viewport are geometrically clipped.

`markers:{show,size,space,width,stroke,fill,dash,cap}` overrides the legacy point controls. `show` accepts true, false, or `"auto"`; auto uses uPlot density visibility and makes `space` meaningful. Marker size is 0–100, space 0–1000, width 0–20, and numeric dash entries 0–100. `pathOptions:{alignGaps,align,ascDesc,extend}` configures named **cosmetic** builders: linear/spline use `alignGaps:-1|0|1`; stepped paths additionally use `align:-1|1`, booleans `ascDesc,extend`. These options do not alter matched numeric paths. Even a stepped path extended to plot edges does not numerically extrapolate.

`matched`, `linear`, `stepped-before`, `stepped-after`, and `spline` are the only named paths. Non-matched paths emit a cosmetic warning; the inspector always uses the selected numerical interpolator. Data, hooks, plugins, series identity/order, scale identity/orientation/time/clamp, event bindings, selection geometry, bands, extra axes and arbitrary callbacks remain protected or unsupported. `iso-time` only formats epoch milliseconds; native time ticks/time templates and cursor sync are not exposed.

```json
{
  "padding": [24, null, 8, null],
  "scales": {"x": {"dir": 1}, "y": {"log": 2, "range": {"min": {"pad": 0.1}, "max": {"pad": 0.15}}}},
  "axes": [{"grid": {"dash": [3, 4], "cap": "round"}}, {"side": 1, "values": "scientific"}],
  "cursor": {"lock": true, "drag": {"x": true, "y": true, "dist": 8, "uni": 16, "setScale": true}},
  "legend": {"isolate": true, "markers": {"dash": "dashed"}},
  "focus": {"alpha": 0.25},
  "drawOrder": ["series", "axes"],
  "select": {"show": true, "over": false}
}
```

Settings and named saved views live in local storage. Export/import uses a validated, versioned JSON envelope containing configuration, experiment/run/metric selections and pins—no credentials or metric/image data. Imported run IDs that are unavailable on the connected server are not selected.

## Image inspection

One selected run/key is displayed at a time. OpenSeadragon receives native-resolution PNG/JPEG/WebP blobs fetched with the bearer header, never token-bearing URLs. Frame metadata includes run, key, step, timestamp and timeline position. Previous/next, timeline scrubbing, keyboard arrows in the viewer, completion-paced play, fullscreen, reset, quarter-turn rotation and horizontal flip are available. Frame swaps retain the viewport; reset is explicit. Requested frames use cancellation plus generation checks through viewer-open completion, so older responses cannot replace the latest request.

The blob cache targets at most six entries and 64 MiB, retaining the currently displayed/requested frame while evicting older entries. Only one next frame is prefetched. URLs are revoked on eviction, run reset, disconnect and teardown. Native decoded image memory can exceed compressed byte size; this is not a tiled-server pyramid or a guarantee of constant decoded memory. Playback waits for loading and adds the selected interval, so the advertised rate is an upper target, not guaranteed wall-clock fps.

## Verification scope

`npm test` covers numerical analysis, adaptive clipping and path geometry, resolved uPlot options, merge/validation limits, log ranges, saved-view safety, utilities and pagination. The options/path tests check original-domain interpolation on nonlinear axes, current viewport projections, fill clipping, reversal, precision/budget warnings, marker styling and run-pair visibility. `test:browser` includes existing API/image fixtures plus focused plot fixtures for zoom/resize path invalidation, pair hide/isolation, short drags, marker creation, singleton visibility and atomic chart rejection. Screenshots/traces are retained under `web/test-results` on failures.

These checks do not claim exhaustive cross-browser testing or real-server integration. Very large unsampled comparisons retain memory proportional to full data and the aligned observation grid. Adaptive tessellation is bounded and approximate, not an exact analytic canvas path. Images remain single-run/single-key; simultaneous image comparison is not implemented.
