# Filtered run selection

Run-list filters are shared per experiment between the main table and chart drawer. This includes Time, Config, Tag, and Event conditions, text search, and status. Conditions, search, and status are restored on reload.

Filters apply as edited. A confirmed nonmatch is removed from each affected view's `selectedRunIds` and saved. Clearing or widening a filter does not reselect those runs. Matching runs can be selected again explicitly. An untouched, unfiltered view keeps its selection.

## Unresolved evidence

`selectedRunIds` contains only the effective selection consumed by cards, cache keys, selection counts, and checkboxes. Previously selected runs whose Event result is unknown move to optional `pendingSelectedRunIds`, which is saved but never plotted or counted as active selection. An unloaded catalog page is not a negative proof either.

- A confirmed match moves pending intent into the active selection.
- A confirmed nonmatch removes the intent permanently.
- Pending scans, failed scans, refresh invalidation, and reload do not by themselves erase unresolved intent.
- Clearing a filter can restore unresolved intent: it was withheld, not proven excluded. This does not restore confirmed nonmatches.
- Text/status or another condition can prove exclusion even while an Event result is pending.
- Explicitly clearing selection cancels pending intent too. Ordinary checkbox edits preserve unrelated pending intent, even when the last confirmed run is unchecked. The table keeps Clear available when only pending intent remains.

## Display and lifecycle

Selected-only mode, sorting, and pagination are display operations, not selection predicates. Explicit native-series cards and rx cards bound to fixed UIDs remain independent of run selection. Selected-source cards follow the reconciled IDs, including while evidence is unresolved.

The shared relative-time clock also reconciles selection. Returning from run details refreshes relative boundaries; navigating to a run's charts does not bypass active filters. Both lists retain their controls while selection changes. Filter-triggered chart updates are deferred and run only when reconciliation changes IDs.

## Integration

The central reconciliation helper is in `run-selection.ts`; `main.ts` owns persistence and notifications. The table reads current workspace selection on session notifications, instead of keeping a stale copy. Session search/status predicates are shared by both lists.

The workspace schema remains version 2 with an optional validated `pendingSelectedRunIds` field. Existing views load without migration. Older frontends with strict validation can reject the saved library when a view contains that new field; do not roll back the frontend while pending selections are saved without first backing up/normalizing those views. Storage failures are reported; active filtering still applies, but a failed browser-storage write cannot guarantee persistence across reload.

No backend change is required. Rebuild/embed the matching frontend when integrating; do not deploy only a subset of these frontend modules.
