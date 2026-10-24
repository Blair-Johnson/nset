# Browser guide

## Choose runs

Open an experiment, select runs with the checkboxes, and open Charts. Search, status filters, and Columns help narrow the run table; metric columns show the latest logged value. Click a run name to inspect its parameters and tags or copy/export its configuration as JSON.

The Charts run drawer changes the comparison in place. Its edge chevron collapses it, and its divider adjusts the width. Selected (N) shows the selected cohort; text and status filters still apply. Clear filters reveals hidden selections without changing which runs are plotted. Color swatches set shared run colors across tables and plots.

Refresh reloads runs and chart data. View actions → Add missing metric charts adds cards for newly logged metric and image keys. Default sections group keys by the prefix before the last slash.

## Edit and arrange charts

Use a card's ⋯ → Edit chart, or Add chart, to open settings beside a live preview. Choose Line, Scatter, Area, Step, or Image panel. Selected runs follows the current comparison; Specific series fixes sources, including across experiments. Save changes applies the draft to that card; Cancel or Escape discards it.

For scalar charts, choose Y metrics and an X source: Step, Wall time, Relative time, or a metric. With a metric on X, Matched at joins channels at the same step, wall time, or relative time, interpolating over their shared range. Relative time is milliseconds since each run's creation. Per-axis options set scales, bounds, labels, and formats; Smoothing and Appearance control interpolation and styling. Central 98% changes the displayed Y range while preserving observations and numerical results.

Dashboard smoothing applies to every scalar card, including collapsed sections. The global X-axis control applies to step/time charts; metric-on-X charts keep their own Matched at setting. Per-card overrides remain until the next global change to that setting. Changing X coordinates resets coordinate-dependent bounds and navigation; image panels have their own controls.

Drag a card title to reorder it or move it between sections. Drag its corner handle to resize; Escape cancels, and arrow keys offer keyboard resizing. Maximize fills the workspace; Restore returns to the saved dimensions. The card menu also duplicates, removes, or resets a chart. Removing cards or sections leaves logged data intact.

## Navigate and measure

- Left-drag to zoom: horizontal selects X, vertical selects Y, diagonal selects both.
- Right-drag or Space + left-drag pans. Ctrl + wheel or Alt + wheel zooms around the pointer; adding Shift zooms X only. Ordinary wheel scrolling moves the page.
- Double-click fits the configured range. With the plot focused, +/− zoom, arrow keys pan, 0 fits, and Backspace returns to the previous view.
- With the pointer over a plot, C cycles vertical cursor placement → horizontal placement → off. Click to place A and B, then drag their lines or enter coordinates under Edit positions. Cursor icons provide the same placement actions.
- The primary delta is B − A. Expand Per-run values / crossings for curve measurements, or Show legend for hover values.

Comparisons load complete histories into browser memory. At duplicate step/time coordinates, the latest inserted observation wins. Interpolation estimates values between observations within the recorded range; smoothing uses the full ordered history. Zooming leaves numerical results unchanged. Log scales omit nonpositive values from the display. Drawing may use bounded approximations while measurements use the analyzed series.

Metric-on-X curves can loop back. When X is nonmonotonic, a vertical cursor has no single Y answer and its value is unavailable; horizontal crossings still report all intersections of the joined polyline. Smooth channel interpolation is sampled at the joined observations for these curves.

## Inspect images

Each panel shows one run/key source at a time. Left-drag zooms into a region; right-drag or Space + left-drag pans. Ctrl + wheel or Alt + wheel zooms around the pointer; +/− also zooms. Double-click or Fit resets the camera. Scrub the timeline, step with previous/next, or play the sequence. Frame changes preserve the camera and keep the current image and caption visible until the next frame is ready.

1:1 pixels shows native pixel size. More contains smooth/nearest display, rotation, and flip. Maximize keeps the timeline with the image. Frames retain their original bytes, and playback waits for loading; its rate is a target.

## Keep views

Views store chart layouts, settings, and run selections in this browser's local storage. Working changes survive reload. Modified marks a layout that differs from its saved version: Save accepts it, Revert to saved restores it, and Save view as… keeps the modified layout in a new view while restoring the original. Run selection remains live when reverting a layout.

View actions → Export view / Import view… transfers layout and source references. Import requires the original experiment on the connected server. Export before clearing browser storage; files contain neither logged data nor tokens, temporary zoom/cursors, or shared run-color overrides. Run colors are separate browser-local preferences.

The access token is kept in session storage. Disconnect clears it and loaded chart/image data.

[Logging](logging.md) · [Development](contributing.md) · [README](../README.md)
