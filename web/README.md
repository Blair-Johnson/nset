# Browser guide

## From experiments to Charts

Open **Experiments** and choose an experiment. In **Runs**, search names, parameters or tags, filter by status, and sort columns to find a comparison. The table includes latest metric values. Check runs and open **Charts**; switching between Runs and Charts keeps the current view’s selection. The **Runs** picker in Charts lets you change it in place.

The initial **Overview** view mixes line charts and image panels in one grid. Sections use the part of each key before its last slash: `train/loss` and `train/prediction` share `train`, while `train/batch/loss` belongs to `train/batch`. Keys without a slash appear in an Overview section. Collapse sections or search charts to focus on a smaller group. **Refresh** reloads the catalog and chart data; **View actions → Add missing metric charts** adds cards for newly available metric or image keys without replacing your existing cards.

## Edit a chart

Open the card’s **three-dot menu (⋯) → Edit chart**. The dialog shows a live preview next to three groups of controls:

**Data** names the chart, chooses its plot type (Line, Scatter, Area, Step, or an Image panel), and selects its sources. Scatter draws logged observation markers without connecting paths; interpolation and smoothing remain separate inspection settings. **Follow selected runs** draws the chosen metric or image keys from the current run selection. For a fixed comparison, select **Choose any run and metric** (or **Choose any run and image**) and search across experiments, runs and keys; changing the dashboard’s run selection will not change those sources.

**Axes** chooses step or time, linear/logarithmic/asinh scales, automatic or manual bounds, labels and number formats. **Y auto range → Central 98%** limits the display, not the data or numerical results. Manual Y bounds take precedence.

**Appearance** controls smoothing strength, linear or smooth interpolation, line/point/area/step styles, grid, legend and size. Expand individual-curve settings for colors and visibility. Image panels show the controls relevant to images instead of numeric axes.

Use **Save changes** to update only this card, or **Cancel** / Escape to discard the draft. Invalid settings show errors without closing the editor. **Add chart → Line plot / Scatter plot / Area plot / Step plot / Image panel** opens the same editor; finish with **Add chart**. No hand-written configuration is needed.

The card menu also offers **Duplicate**, **Wide / Normal width**, **Move up / Move down** and **Remove**. Drag a card title to move it to another section. Use section menus to rename, reorder or remove sections. Removing cards or sections never deletes logged data. **Maximize** gives either card type more space.

## Keep and share views

A named view remembers the selected runs, sections, card sources and chart settings. Edits save automatically in this browser’s local storage; views are not stored on the tracker server or synchronized between browsers. Switch views with **Saved view**, and use the **View actions (⋯)** menu to **Save as…**, rename, export, import or remove a view. Export before clearing browser storage if you want to keep a copy.

**Export view** downloads a file that **Import view…** can read without manual editing. It contains layout, settings and experiment/run/key references—not tokens, metric histories or image bytes. Import requires the original experiment to exist on the connected server; it does not copy experiments or match runs by name. Unavailable sources chosen for a fixed comparison stay listed as unavailable so you can repair the selection. Temporary zoom positions and A/B/threshold cursors are not saved in these files.

## Navigate and inspect a line chart

| Action | Control |
| --- | --- |
| Move around | **Pan**, then drag; **Space + drag** temporarily pans in other modes. |
| Zoom into a region | **Zoom**, then drag a box; choose **X**, **Y** or **X + Y**. |
| Zoom near the pointer | **Alt + wheel**; **Shift + Alt + wheel** zooms X only. Ordinary wheel scrolling moves the page. |
| Zoom with buttons | **+ / −**. |
| Restore the configured range | **Fit** or double-click. |
| Return to the previous range | **Back**. |

With the plot focused, **+ / −** zoom, **arrow keys** pan, **0** fits and **Backspace** goes back. These shortcuts do not take over text fields.

Hover for interpolated curve values. In **Inspect**, select **A** or **B** and click to place it, drag either vertical line, or enter its coordinate. The table shows each curve’s A/B values and difference. In **Threshold**, click or drag the horizontal line, or enter a value; expand each curve’s result to see every crossing and equal-value interval. **Clear** removes the cursors. On a time axis, numeric cursor coordinates are UTC epoch milliseconds.

Each comparison uses complete histories. Duplicate coordinates use the latest inserted observation; values between observations are estimates, and out-of-range answers show an em dash rather than extrapolation. Smoothing is applied to the full ordered history, so moving the viewport does not change answers. Smooth interpolation is shape-preserving. Optional stepped or other display-only line styles do not change the values reported by Inspect or Threshold. **Central 98%** displays a clipping notice and **Fit all**; choose **All values** in the editor to turn that policy off permanently.

## Inspect images

Each image panel displays one run/key source at a time; choose a source when the panel has several. Different panels are independent. Drag to pan, use **+/−** or **Alt + wheel** to zoom, and use the timeline, previous/next buttons or playback to move between frames. The caption identifies the actual logged step. Frame changes preserve the camera, so you can inspect the same region across a sequence.

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

Custom charts support multiple scalar series, including different metrics from the same run or sources across experiments. The X axis is step or timestamp, not an arbitrary metric; extra axes, expression charts and overlaid image comparisons are not implemented. These workflows do not imply feature parity with MLflow or W&B.

Executed checks and current limitations are recorded in `../docs/verification.md`. The browser tests retain failure screenshots and traces in `web/test-results`.
