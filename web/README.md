# Browser guide

## From experiments to Charts

Open Experiments and choose an experiment. In Runs, search names, parameters or tags, filter by status, and sort columns; the table includes latest metric values. Use checkboxes—not row highlighting—to select runs. Charts keeps that selection and provides a persistent left Runs drawer for changing it in place. Use the chevron on the drawer’s right edge to collapse or restore it, and drag the divider to adjust its width.

Click a run name to open its dedicated detail page. The configuration viewer groups dotted keys and nested objects, shows typed values, and searches paths and values. Copy JSON and Export JSON preserve the logged configuration; tags remain separate. This is a viewer for parsed run parameters, not a raw YAML file or artifact browser. Click a color swatch to choose a shared run color across the table, drawer and plots. Run-color overrides are browser-local preferences, separate from saved views and their exports.

The initial Overview view mixes scalar charts and image panels. Sections use the part of each key before its last slash: `train/loss` and `train/prediction` share `train`, while `train/batch/loss` belongs to `train/batch`. Keys without a slash appear in Overview. Collapse sections or search charts to focus the workspace. Refresh reloads the catalog and chart data; View actions → Add missing metric charts adds cards for newly available metric or image keys without replacing existing cards.

## Dashboard controls

X axis offers Step, Wall time and Relative time. Wall time uses logged timestamps; Relative time is timestamp minus the run’s `created_at`, in milliseconds—not time since the first observation. Smoothing ranges from None to More, with more smoothing giving new observations less weight.

Changing a global control updates that setting in every scalar card’s saved configuration, including cards in collapsed sections. Image panels are unaffected. Mixed per-chart settings display Mixed and are not changed on load. You can override individual charts in the editor until the next global change to that setting. Changing the coordinate system resets coordinate-dependent X bounds and navigation/cursors; a smoothing-only change preserves axis settings.

## Edit and arrange charts

Use ⋯ → Edit chart for a live preview beside Data, Axes and Appearance controls. Data selects Line, Scatter, Area, Step or Image panel and its sources. Follow selected runs tracks the current comparison; Choose any run and metric (or image) fixes sources across experiments. Scatter draws observation markers; interpolation and smoothing remain separate inspection settings.

Axes → X values offers Step, Wall time or Relative time (run start), alongside scales, bounds, labels and formats. Y auto range → Central 98% clips the display, not the numerical results; manual Y bounds take precedence. Appearance includes smoothing, interpolation, styles, grid and an optional compact legend; expand Show legend on the card when enabled. Individual-curve settings control colors and visibility. Image panels show image-specific settings.

Save changes updates only this card; Cancel or Escape discards the draft. Invalid settings keep the editor open. Add chart uses the same editor and finishes with Add chart.

Drag the corner Resize chart handle to change width and height independently; arrow keys also adjust it, with Shift for larger steps. Dimensions persist in the view. Maximize chart fills the available space; Restore chart returns to the saved size. The card menu offers Duplicate, Move up / Move down and Remove. Drag a title between sections; section menus rename, reorder or remove sections. Removing cards or sections never deletes logged data.

## Keep and share views

View identifies a saved layout, run selection and chart settings; Overview is the initial view’s name. A single view appears as plain text, with a selector when multiple views exist. Edits save automatically in this browser’s local storage; views are not stored on the tracker server or synchronized between browsers. Use View actions (⋯) → Save view as… to create another view, or rename, export, import or remove one. Export before clearing browser storage if you want to keep a copy.

**Export view** downloads a file that **Import view…** can read without manual editing. It contains layout, settings and experiment/run/key references—not tokens, metric histories, image bytes or shared run-color overrides. Saved-view files are not data backups. Import requires the original experiment to exist on the connected server; it does not copy experiments or match runs by name. Unavailable sources chosen for a fixed comparison stay listed as unavailable so you can repair the selection. Temporary zoom positions and vertical/horizontal A/B cursors are not saved in these files.

## Navigate and inspect a scalar chart

Left-drag to zoom: a mostly horizontal gesture selects X, a mostly vertical gesture selects Y, and a diagonal gesture selects both. Right-button drag or Space + left-drag pans. Hover crosshairs, markers and readouts hide during panning; pinned cursors remain. Alt + wheel zooms near the pointer; Shift + Alt + wheel zooms X only. Ordinary scrolling moves the page.

The icon controls have accessible labels: Zoom out (−), Zoom in (+), Fit configured range and Previous view (back). Double-click also fits. With the plot focused, +/− zoom, arrow keys pan, 0 fits and Backspace goes back; shortcuts do not take over text fields.

Hover for interpolated values. Activate Add vertical cursor or Add horizontal cursor once, then click to place A and B. Empty-space dragging still zooms while either cursor is waiting; right-button or Space + left-drag still pans. Drag an existing cursor line to move it or enter an exact coordinate. The primary delta is B − A between cursor positions: steps or a signed duration for vertical cursors, metric values for horizontal cursors. Per-run values, crossings and equal-value intervals remain available as secondary results. Clear cursors removes both pairs. Wall-time coordinates are UTC epoch milliseconds; relative-time coordinates are milliseconds from run creation.

Each comparison uses complete histories. Duplicate coordinates use the latest inserted observation; values between observations are estimates, and out-of-range answers show an em dash rather than extrapolation. Smoothing uses the full ordered history, so moving the viewport does not change answers. Smooth interpolation is shape-preserving. Stepped and other display-only line styles do not change numerical cursor answers. Central 98% displays a clipping notice and Fit all; choose All values in the editor to disable that policy permanently.

## Inspect images

Each image panel displays one run/key source at a time; choose a source when the panel has several. Different panels are independent. Drag to pan, use **+/−** or **Alt + wheel** to zoom, and use the timeline, previous/next buttons or playback to move between frames. The caption identifies the actual logged step. Frame changes preserve the camera, so you can inspect the same region across a sequence. The current decoded image and its caption remain until the replacement is ready, rather than flashing a Loading frame.

**Fit** resets the view, and **1:1 pixels** shows native pixel size. **More** contains smooth/nearest pixel display, rotation and flip. **Maximize** keeps the image and timeline together. Images are not recompressed or interpolated between steps. Playback waits for frames to load, so its selected rate is a target rather than guaranteed playback speed.

## Run and verify locally

The browser uses Vite, TypeScript, uPlot and OpenSeadragon. Dependencies are pinned in `package-lock.json`, and assets are bundled locally. From the repository root:

```sh
pixi install --locked
pixi run web-install
pixi run npm --prefix web run build
pixi run npm --prefix web test
pixi run npm --prefix web run dev
# Optional Chromium fixtures and retained screenshots:
pixi run npm --prefix web exec -- playwright install chromium
pixi run npm --prefix web run test:browser
```

Run the Rust server separately using the root README’s instructions. Vite forwards `/api` to `127.0.0.1:8080`; the built application uses same-origin requests. Enter the server token in the connection dialog. It is kept in session storage, never image URLs or exported views. **Disconnect** clears the token and loaded chart/image data. Remote access requires HTTPS or an SSH tunnel. Node is needed to build the UI, not to serve the bundled executable.

## Scope and precision

Full histories consume browser memory; this is not a claim of unlimited scale. Curves use adaptive drawing where needed, with bounded approximation rather than an exact analytic canvas path. Numerical queries use the underlying complete series, not drawing samples. Log scales leave nonpositive values out of the display rather than changing observations. Images use a bounded compressed-byte cache, but decoded images can require more memory; there is no tiled image server.

Custom charts support multiple scalar series, including different metrics from the same run or sources across experiments. The X axis is step, wall time or run-relative time, not an arbitrary metric; extra axes, expression charts and overlaid image comparisons are not implemented. These workflows do not imply feature parity with MLflow or W&B.

Executed checks and current limitations are recorded in `../docs/verification.md`. The browser tests retain failure screenshots and traces in `web/test-results`.
