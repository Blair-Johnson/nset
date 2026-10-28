import type { Api, Experiment, Run } from "./api";
import type { Point } from "./math";
import type { ViewConfig } from "./config";

export type SeriesKind = "metric" | "image";
export interface CatalogSeries {
  run_id: string;
  key: string;
  kind: SeriesKind;
  count: number;
  last_step: number;
  last_timestamp: number;
  last_value: number | null;
}
export interface Catalog {
  /** Native metric watermark captured with this catalog snapshot. */
  metric_seq?: number;
  rx?: {
    id: string;
    name: string;
    error?: string;
    nextAfter?: string | null;
    highWater?: string;
    sourceGeneration?: string;
  };
  experiments: Experiment[];
  runs: Run[];
  series: CatalogSeries[];
}
export interface SeriesRef {
  runId: string;
  key: string;
  kind: SeriesKind;
}
export type ChartSource =
  | { mode: "selected"; keys: string[] }
  | { mode: "explicit"; series: SeriesRef[] };
/** Oscilloscope XY mode: what supplies each trace's horizontal coordinate.
 * The chart's `config.axis` (step / wall time / relative time) is the join
 * parameter shared by the Y and X series; it no longer appears on screen.
 * - "key": each Y trace pairs with the metric `key` from the Y trace's own run
 *   (category × category, one curve per run).
 * - "series": every Y trace pairs with one specific series, from any run or
 *   experiment (one-off comparisons).
 * Either binding combines with either Y source mode. */
export type XBinding =
  { mode: "key"; key: string } | { mode: "series"; series: SeriesRef };
export interface CardLayout {
  width: number;
  height: number;
}
/** Literal own-property path beneath a run's params (dots are not separators). */
export interface ChartConfigField {
  path: string[];
  label?: string;
}
export interface ChartMeasurement {
  axis: "x" | "y";
  a: number;
  b?: number | null;
}
export interface ChartDetails {
  markdown?: string;
  configFields?: ChartConfigField[];
  /** Authored configuration-table headings keyed by stable run identity, not semantic run labels. */
  configRunLabels?: Record<string, string>;
  measurements?: Record<string, ChartMeasurement>;
}
export interface ChartSpec {
  records?: import("./records").RecordBinding;
  id: string;
  title: string;
  kind: "timeseries" | "image";
  source: ChartSource;
  /** Absent: X is the join parameter itself (classic step/time plot). */
  x?: XBinding;
  config: ViewConfig;
  outliers: "all" | "robust";
  size: "normal" | "wide";
  layout?: CardLayout;
  details?: ChartDetails;
}
export interface Section {
  id: string;
  title: string;
  collapsed: boolean;
  cards: ChartSpec[];
}
export interface Workspace {
  version: 2;
  id: string;
  name: string;
  experimentId: string;
  selectedRunIds: string[];
  /** Selected intent withheld until Event/filter evidence resolves. Never plotted. */
  pendingSelectedRunIds?: string[];
  /** View-wide semantic names keyed by stable run identity. */
  runLabels?: Record<string, string>;
  sections: Section[];
  updatedAt: number;
}
export interface WorkspaceLibrary {
  version: 2;
  views: Workspace[];
  activeByExperiment: Record<string, string>;
}
export interface ResolvedSeries extends SeriesRef {
  id: string;
  run: Run;
  label: string;
  /** Present for XY charts: the series supplying this trace's X coordinate. */
  x?: { ref: SeriesRef; run: Run; label: string };
}
export interface MetricLoader {
  load(
    ref: SeriesRef,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Point[]>;
  clear(): void;
  watch?(refs: SeriesRef[], onChange: () => void): () => void;
  markDirty?(refs?: SeriesRef[]): void;
  setLiveEnabled?(enabled: boolean): void;
  resetLive?(): void;
  setLiveStatusListener?(callback: (error: string | null) => void): void;
}
export interface CardContext {
  api: Api;
  catalog: Catalog;
  selectedRunIds: string[];
  store: MetricLoader;
  runLabels?: Record<string, string>;
  labelMode?: "semantic" | "original";
}
export interface CardActions {
  onEdit(id: string): void;
  onDetails?: (id: string) => void;
  onRemove(id: string): void;
  onDuplicate(id: string): void;
  /** Return the chart's settings to new-chart defaults, keeping its data. */
  onReset?: (id: string) => void;
  onMove(id: string, delta: -1 | 1): void;
  onResize(id: string, size: "normal" | "wide"): void;
  onDimensions?: (id: string, layout: CardLayout) => boolean | void;
}
export type InteractionMode =
  "pan" | "zoom" | "inspect" | "threshold" | "navigate";
export type NavigationAxis = "x" | "y" | "both";
export interface PlotInteraction {
  mode: InteractionMode;
  axis: NavigationAxis;
  inferZoomAxes?: boolean;
  directGestures?: boolean;
  cursorAxis?: "x" | "y";
  /** Hover-scoped C shortcut; owner cycles state and reconfigures interaction. */
  onCursorModeCycle?: () => void;
  onHorizontalPin?: (pin: "a" | "b", value: number) => void;
  activePin: "a" | "b";
  onPin?: (pin: "a" | "b" | "threshold", value: number) => void;
  /** A direct-gesture placement click completed after pointer capture release. */
  onPlacementComplete?: (pin: "a" | "b" | "threshold" | "yA" | "yB") => void;
  onHover?: (x: number | null, pointer?: [number, number]) => void;
  onViewChange?: () => void;
}
