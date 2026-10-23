# Browser workbench

## Run and verify

The browser uses Vite, TypeScript, uPlot, OpenSeadragon, and native DOM. Dependencies are pinned in `package-lock.json`; all assets are bundled locally. Integrate `src/math.ts` and `src/math.test.ts` from the numerical implementation before building.

From the repository root:

```sh
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

The default **matched** path draws that same interpolant. PCHIP drawing uses a fixed 16 subdivisions per canonical interval; exact numerical readouts do not use this tessellation. Raw point markers are a separate layer at actual observed x values, remain unsmoothed, and are not manufactured at other runs’ logging steps. Unequal grids use a sorted union with numerical interpolation for curves and null outside each run’s domain. Nonpositive log samples are excluded only from display, with an explicit warning; the inspector still analyzes them. Linear or asinh displays signed values.

Pinned A/B cursors can be entered numerically or placed by clicking the plot with the active pin selected. Drag zoom changes the viewport only. Reset zoom returns to configured ranges. The threshold field drives both the horizontal overlay and the complete intersection table. Blank/out-of-domain values display an em dash. An enabled live hover legend reports the nearest drawing-grid point, not the exact pinned interpolation; a warning identifies this boundary. Legend toggles are temporary display choices; use per-run configuration for persisted visibility.

## Configuration and saved views

The configuration tab exposes x/y linear, log and asinh scales, ranges, labels, named formatters, responsive/fixed dimensions, grid/ticks/legend/crosshair/zoom, palette selection, and default/per-run color, width, dash, raw markers, marker size, area opacity, visibility and display path. Per-run overrides take precedence over defaults and the palette. An unchecked override follows future defaults. Configuration applies atomically after validation.

`matched`, `linear`, `stepped-before`, `stepped-after`, and `spline` are safe named display paths. Non-matched paths are cosmetic and emit a warning: they do not change the selected numerical interpolator. Choose matched for quantitative reading from the curve.

Advanced JSON is deliberately a **subset**, not arbitrary uPlot serialization. It deep-merges objects and array entries by index into the built-in options. Advanced JSON is applied last, so it can override corresponding common presentation toggles. It cannot override protected analysis settings. Supported roots:

- `title`: string; `padding`: four numbers `[top,right,bottom,left]`.
- `legend`: `show`, `live` booleans.
- `cursor`: `show`, `x`, `y` booleans; `drag`: `x`, `y` booleans and numeric `dist`.
- `axes`: up to two patches `[x,y]`. Supported fields: `show`, `label`, `font`, `labelFont`, `stroke`, `size`, `gap`, `labelSize`, `labelGap`, `rotate`, `values`, `grid`, `ticks`, `border`.
- Axis `values` is a named formatter: `number`, `fixed-2`, `scientific`, or `iso-time`. Each `grid`/`ticks`/`border` object accepts `show`, `stroke`, `width`, `dash`; only ticks additionally accepts `size`. Colors use `#rrggbb`.

Example:

```json
{
  "padding": [24, 28, 8, 8],
  "axes": [
    {"values": "scientific", "grid": {"dash": [3, 4]}},
    {"label": "Objective", "ticks": {"size": 6}}
  ],
  "cursor": {"drag": {"x": true, "y": true, "dist": 12}}
}
```

Unknown or protected overrides are errors shown next to Apply; they are not ignored. `data`, `hooks`, `plugins`, `scales`, `series`, sizing and inspector identity remain protected. Use built-in controls for those settings. Arbitrary executable callbacks, event handlers, plugin objects, callback strings, prototype keys and JavaScript evaluation are unsupported. Named paths/formatters are the only function-valued configuration boundary.

Settings and named saved views live in local storage. Export/import uses a validated, versioned JSON envelope containing configuration, experiment/run/metric selections and pins—no credentials or metric/image data. Imported run IDs that are unavailable on the connected server are not selected.

## Image inspection

One selected run/key is displayed at a time. OpenSeadragon receives native-resolution PNG/JPEG/WebP blobs fetched with the bearer header, never token-bearing URLs. Frame metadata includes run, key, step, timestamp and timeline position. Previous/next, timeline scrubbing, keyboard arrows in the viewer, completion-paced play, fullscreen, reset, quarter-turn rotation and horizontal flip are available. Frame swaps retain the viewport; reset is explicit. Requested frames use cancellation plus generation checks through viewer-open completion, so older responses cannot replace the latest request.

The blob cache targets at most six entries and 64 MiB, retaining the currently displayed/requested frame while evicting older entries. Only one next frame is prefetched. URLs are revoked on eviction, run reset, disconnect and teardown. Native decoded image memory can exceed compressed byte size; this is not a tiled-server pyramid or a guarantee of constant decoded memory. Playback waits for loading and adds the selected interval, so the advertised rate is an upper target, not guaranteed wall-clock fps.

## Verification scope

`npm test` covers JSON validation/deep merge, protected overrides, saved-view safety, numeric utility edge cases, latest-response tokens and full-snapshot pagination. The numerical owner adds the canonicalization/interpolation suite. `test:browser` uses deterministic API fixtures, paginated irregular grids, plain-text hostile-looking names, authenticated PNG responses, inspector controls, configuration errors, view export, timeline actions, delayed-frame races, zoom-invariant readouts and a narrow mobile viewport. Screenshots/traces are retained under `web/test-results`.

These hooks do not claim manual visual verification or exhaustive cross-browser testing. Very large unsampled comparisons consume memory proportional to full data and the aligned drawing grid. PCHIP drawing is tessellated rather than an exact analytic canvas path. Images are single-run/single-key; simultaneous image comparison is not implemented.
