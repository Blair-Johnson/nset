# UX reference survey and redesign decisions

This redesign uses primary-source inspection, not a claim of live feature parity. The MLflow frontend was cloned sparsely at commit `1795b4d7cf870078174a90fe955fab8cf5317cd2`; W&B's published documentation source was cloned at `86eefc342c347f15ce6a4cda3114e9daeaccd403`. The references are outside the application repository in sibling `mlflow-reference` and `wandb-reference` directories. No upstream implementation code was copied into this application. The W&B website URL initially inspected redirected to a login page, so its public documentation source was used instead.

## MLflow

Paths here are relative to `mlflow/server/js/src/experiment-tracking/` in the reference clone. `components/ExperimentListTable.tsx` presents experiment names as links in a table with metadata columns. `components/experiment-page/components/runs/ExperimentViewRuns.tsx` keeps run selection connected to comparison charts, including a split workspace mode. We reuse the experiment/run hierarchy and preserve selection across Runs and Charts; the redesign need not recreate every feature-flagged split-pane variant.

`components/runs-compare/RunsCompare.tsx` contains the vertically scrolling chart workspace. `components/runs-charts/runs-charts.types.ts` groups metric and image keys by the prefix before the final slash, and `components/runs-charts/components/sections/RunsChartsSectionAccordion.tsx` implements collapsible sections. This directly informs the mixed timeseries/image dashboard: namespaces are sections, not global modality tabs.

`components/runs-charts/components/cards/ChartCard.common.tsx` puts configure, delete, export/download and move actions on individual cards, with fullscreen nearby. `components/runs-charts/components/RunsChartsConfigureModal.tsx` stages a draft beside a chart preview and uses Cancel/Save changes. `components/runs-charts/components/config/RunsChartsConfigureLineChart.tsx` groups metric selection, X/Y scales and limits, points, smoothing and outlier options. We use a contextual Edit chart dialog with approachable Data, Axes and Appearance groups and optional extra controls. An editor must not mutate another chart or leak an uncommitted draft.

`components/runs-charts/components/RunsMetricsLinePlot.tsx` disables scroll zoom and wires hover/unhover; double click restores scale. Standard pan/zoom controls are partly inherited from Plotly and were not exercised in a live MLflow instance. Our explicit toolbar and keyboard/modifier bindings are designed and tested in this app rather than claimed to be identical.

We deliberately do not copy the sampled history path in `components/runs-charts/components/cards/RunsChartsLineChartCard.tsx`, which requests a bounded result count and viewport-derived step range. Nor do we silently copy its first-N run defaults or percentile point removal. Our full histories, interpolation and cursor answers remain independent of viewport size. Optional central-percentile display changes the Y viewport only and is labeled.

## W&B

Paths are relative to the W&B docs clone. `models/app/features/panels/line-plot.mdx` describes adding individual or multi-metric panels, selecting a panel's settings, editing a grouped drawer and applying changes. It distinguishes panel settings from section and workspace defaults. Its zoom guidance describes rectangular two-axis zoom; we provide a visible Zoom tool and explicit axis choice while leaving an unmodified wheel available for page scrolling.

`models/app/features/cascade-settings.mdx` separates workspace, section and panel settings. `models/app/features/panels.mdx` describes automatic/manual panels and section organization. We reuse named views, namespace defaults and panel-local customization, but avoid exposing an inheritance/configuration system before it serves a clear task. The source also documents broader products such as expressions, grouping and other chart types; these are not implemented merely because they appear in the reference.

## Adopted interaction contract

Experiments open a run table with selection, search, status filters, sortable columns and latest metric values. Charts opens a saved view of that selection, containing collapsible namespace sections and mixed cards. A compact run picker avoids a round trip to the table for simple selection changes. Default charts follow selected runs; custom charts can choose explicit metric/image series across experiments.

Every chart owns its menu and editor. Users choose data and familiar scale/range/smoothing/style options through controls, not JavaScript. Related advanced settings use progressive disclosure. The normal canvas area is not surrounded by implementation explanations. Hover gives values; an explicit Inspect mode reveals A/B comparison controls; Threshold reveals crossing queries. Pan, Zoom, Fit, Back and +/- controls make navigation visible, with modifier-wheel and focused keyboard equivalents.

The acceptance criteria are complete journeys: find experiments, choose runs, inspect a mixed namespace dashboard, edit one chart without changing others, build a cross-experiment comparison, save/reload a view, navigate a curve without changing query results, and scrub images without losing the camera. Desktop/narrow/modal/fullscreen captures and real-server interaction checks supplement numerical and backend regression tests.
