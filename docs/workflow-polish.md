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

The proposed table alternative keeps the existing Columns entry point and adds searchable, grouped parameter and metric choices. It must distinguish a literal dotted key from a nested path with the same display text, preserve false and zero, and label metric summaries as latest values rather than best values. Bounded scrolling and sticky row identity are evaluated separately, so a field-picker improvement does not automatically justify changing the whole table layout.

## Story: tune a plot while retaining the comparison

A researcher opens a chart's editor, changes its source or types new axis bounds, and watches the preview to judge the result. Destroying the preview while a second bound is being typed removes the context needed to finish the task. Equally, leaving an old plot onscreen without explaining that it is old would be misleading.

The selected direction retains a compatible last-good scalar preview and makes pending or invalid changes explicit. A competing variant keeps the preview only for invalid input but replaces it while source data loads. The first direction preserves spatial context across both interruptions, provided its old source identity remains truthful and a stale request cannot replace the newest result. Empty selections and a switch to images require their own states, not an unrelated scalar preview. Range feedback must describe the effective range: a saved central-percent policy does not imply clipping when explicit bounds override it.

## Story: navigate a plot without reading a row of framed buttons

The same three-run plot was rendered with outlined, quiet and grouped toolbar treatments in r166. Across the alternatives, the desktop card remained 1000 by 290 pixels and the drawable area 854 by 131 pixels. At a 390-pixel viewport, the card remained 358 by 290 and the drawable area 218 by 139. Button targets remained 28 by 28; enabled icon contrast passed 4.5:1, and keyboard focus retained a visible outline.

The quiet treatment is selected because it removes repeated button frames without hiding actions or shrinking targets. The grouped variant adds a surrounding frame without reducing the interaction count or increasing the plot area. This is a constrained design choice, not a measured preference from users. Consistent SVG icons also distinguish fitting the configured range from maximizing the card, which previously shared a glyph. Hover, active placement, disabled history and keyboard focus remain distinct states.

## Story: inspect image changes in a stable region

The existing image workflow lets a researcher zoom into a region and scrub adjacent frames without a loading label changing the layout. That behavior remains a regression requirement. Changing to another run or image stream currently resets frame and camera. Aligning different streams by step, time or image coordinates requires an explicit contract, so this round does not silently invent one.

## Integration evidence

The drawer component passed 277 unit tests, the production build and 19 browser scenarios in r172 before integration. The parent toolbar passed 18 focused browser scenarios in r180, including dark contrast, active cursor styling, maximize/restore, stable folds and reset behavior. An initial production check found that hover styling hid the active cursor border; the selector was corrected rather than weakening the assertion. Whole-release acceptance remains pending until the editor and table changes are integrated. No intermediate screenshot comparison alone authorizes replacing the deployed preview.
