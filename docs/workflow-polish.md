# Workflow-led polish

This round starts from `cf61fa1`, the verified compact workspace. It preserves complete metric histories, direct zoom and pan, cursor position deltas, the C placement cycle, stable image scrubbing, and the run configuration browser. The aim is to remove interruptions from ordinary analysis, not add another layer of controls.

## Reference and comparison method

Official MLflow and W&B illustrations are retained by `scripts/ux_references.py`, with source locations, dimensions and SHA-256 hashes in the generated manifest. The first bundle is in rx r157. The MLflow tracking illustration includes a 2.8.0 version label even though it is served from the current documentation path; it is a layout reference, not evidence about the latest release. W&B assets are pinned to documentation commit `86eefc342c347f15ce6a4cda3114e9daeaccd403`. Local MLflow source was inspected at `1795b4d7cf870078174a90fe955fab8cf5317cd2`.

The relevant patterns are adjacent run selection and plots, searchable choice of table fields, and a preview next to the settings that affect it. We do not copy every reference detail. In particular, a tab-heavy editor would contradict the user's request for one consistent form. Run colors, compact sections and direct manipulation remain the established design.

Actual screenshots are retained for baseline and alternatives at matching viewport sizes and with identical data. Browser screenshot payloads are omitted in this agent's tool view, so this record does not claim direct visual inspection. Measured element bounds, decoded pixels, contrast checks, interaction tests and native image OCR provide narrower evidence. `scripts/ui_image_review.swift` records OCR geometry; r164 inspected the official images. OCR is not a substitute for aesthetic review or usability testing.

## Story: narrow a comparison without losing the selected cohort

A researcher compares a dozen runs out of a larger sweep, filters the run drawer to find one name, then wants to inspect which runs still contribute to the plots. The existing checkboxes correctly retain selection, but the filtered list can hide selected runs. A count alone does not make those hidden choices inspectable.

The selected alternative turns the existing selected count into a compact toggle and reports hidden selected runs. Search and status filters remain non-destructive: changing them never changes which data is plotted. The competing alternative, a hidden count with a replacement-selection action, uses little space but makes inspecting a cohort depend on an action that changes it. The selected-only filter separates looking from changing. In r161, inspecting and removing a hidden selected run required three scripted activations with this design instead of two with the baseline, but reduced the list to scan from 60 status-filtered rows to exactly 12 selected rows. This is an inspectability improvement, not a claim of fewer clicks or faster human task time. The implementation passed stable row identity and focus, truthful count, and failed-save rollback checks in r172.

## Story: explain a promising run using configuration columns

After spotting a better loss curve, a researcher wants to compare learning rate and batch size across the candidate runs. Opening each run's configuration page is appropriate for detail, but repetitive for comparing two scalar values. A metric-only column picker cannot answer this task.

The implemented table alternative keeps the existing Columns entry point and adds searchable, grouped parameter and metric choices. Exact scalar paths distinguish a literal dotted key from a nested path, preserve false and zero, and label metric summaries as latest rather than best. In the 120-run/100-metric comparison, all three alternatives used 11 scripted conceptual steps; the chosen design eliminated two detail-page round trips and allowed side-by-side reading. It did not demonstrate faster human completion. A separate layout comparison justified bounded scrolling and sticky context: desktop headers moved from offscreen at y=−1243.5 to y=122 after scrolling, row height fell from 42.5 to 32 pixels, and the pager remained inside the 1000-pixel viewport. At 390 pixels only the checkbox stays pinned horizontally, leaving 320 pixels for scrolling data rather than freezing a wide name column over it. The final component build, 279 units and 28 browser checks passed in r182.

## Story: tune a plot while retaining the comparison

A researcher opens a chart's editor, changes its source or types new axis bounds, and watches the preview to judge the result. Destroying the preview while a second bound is being typed removes the context needed to finish the task. Equally, leaving an old plot onscreen without explaining that it is old would be misleading.

The implemented direction retains a compatible last-good scalar preview and makes pending or invalid changes explicit. A competing variant retained the preview only for invalid input but replaced it while source data loaded. With a 1600ms source delay, the chosen design retained all 7,421 painted desktop pixels and 4,035 mobile pixels of the baseline at the 750ms observation, while the baseline and competing variant had no loading-state canvas. The mobile preview pane stayed 286.95 pixels high rather than shrinking to 258.5. The old title and observation count remain until replacement succeeds; tests reject stale requests, verify errors and Retry, and clear unrelated content for empty selections or image transitions. Range feedback now reports central-percent clipping only when that range was actually applied. The final component build, 278 units and 50 browser checks passed in r181; the capture inventory and comparison are retained in r183.

## Story: navigate a plot without reading a row of framed buttons

The same three-run plot was rendered with outlined, quiet and grouped toolbar treatments in r166. Across the alternatives, the desktop card remained 1000 by 290 pixels and the drawable area 854 by 131 pixels. At a 390-pixel viewport, the card remained 358 by 290 and the drawable area 218 by 139. Button targets remained 28 by 28; enabled icon contrast passed 4.5:1, and keyboard focus retained a visible outline.

The quiet treatment is selected because it removes repeated button frames without hiding actions or shrinking targets. The grouped variant adds a surrounding frame without reducing the interaction count or increasing the plot area. This is a constrained design choice, not a measured preference from users. Consistent SVG icons also distinguish fitting the configured range from maximizing the card, which previously shared a glyph. Hover, active placement, disabled history and keyboard focus remain distinct states.

## Story: inspect image changes in a stable region

The existing image workflow lets a researcher zoom into a region and scrub adjacent frames without a loading label changing the layout. That behavior remains a regression requirement. Changing to another run or image stream currently resets frame and camera. Aligning different streams by step, time or image coordinates requires an explicit contract, so this round does not silently invent one.

## Integration evidence

The drawer component passed 277 unit tests, the production build and 19 browser scenarios in r172 before integration. The parent toolbar passed 18 focused browser scenarios in r180, including dark contrast, active cursor styling, maximize/restore, stable folds and reset behavior. An initial production check found that hover styling hid the active cursor border; the selector was corrected rather than weakening the assertion. The merged release passed the complete acceptance script in r186, including 224 Chromium scenarios and the real-server image and 60-run workflows. A subsequent independent review identified the mobile stacking issue below, so deployment waits for the corrected unified run. No intermediate screenshot comparison alone authorizes replacing the deployed preview.

## Post-integration review

A read-only review found that the mobile Run header shared the pinned checkbox header's stacking level and could cover it during partial horizontal scrolling. The new hit-testing regression reproduced the defect in r191. The correction lowers only that unpinned mobile header. Twelve focused tests passed in r192, including pointer selection and keyboard Space at the overlapping scroll position. The expanded real-server parameter/cohort journey also passed in r193; the corrected unified acceptance remains the deployment gate.

## Follow-up axis experiment

The isolated, test-only axis comparison in r190 rendered 72 states and checked 288 top/right cursor badges without a badge collision. Removing only a demonstrably redundant Y title gained 22 pixels of drawable width, or 10.09% on the tested mobile card; mixed metrics, nonredundant titles and explicit overrides were unchanged. A measured gutter gained up to 32 pixels for short values but needed seven more pixels for billion-scale ticks. Neither changes drawing height. This does not justify blanket gutter reduction.

The comparison exposed existing billion-scale tick/title overlap and right-edge timestamp clipping. These remain follow-up work, not hidden exceptions to a claim of universal label safety. Production axes are unchanged in this release. The review is retained on `review/axis-density` at `b07abc5`, with PNGs and canvas text bounds under `../.rx-worktrees/r190/web/test-results/`. Any production change must also verify stable geometry through pan/zoom and preserve explicit axis settings.
