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
export interface CardLayout {
  width: number;
  height: number;
}
export interface ChartSpec {
  id: string;
  title: string;
  kind: "timeseries" | "image";
  source: ChartSource;
  config: ViewConfig;
  outliers: "all" | "robust";
  size: "normal" | "wide";
  layout?: CardLayout;
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
}
export interface MetricLoader {
  load(
    ref: SeriesRef,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Point[]>;
  clear(): void;
}
export interface CardContext {
  api: Api;
  catalog: Catalog;
  selectedRunIds: string[];
  store: MetricLoader;
}
export interface CardActions {
  onEdit(id: string): void;
  onRemove(id: string): void;
  onDuplicate(id: string): void;
  onMove(id: string, delta: -1 | 1): void;
  onResize(id: string, size: "normal" | "wide"): void;
  onDimensions?: (id: string, layout: CardLayout) => boolean | void;
}
export type InteractionMode = "pan" | "zoom" | "inspect" | "threshold";
export type NavigationAxis = "x" | "y" | "both";
export interface PlotInteraction {
  mode: InteractionMode;
  axis: NavigationAxis;
  inferZoomAxes?: boolean;
  directGestures?: boolean;
  cursorAxis?: "x" | "y";
  onHorizontalPin?: (pin: "a" | "b", value: number) => void;
  activePin: "a" | "b";
  onPin?: (pin: "a" | "b" | "threshold", value: number) => void;
  onHover?: (x: number | null) => void;
  onViewChange?: () => void;
}
