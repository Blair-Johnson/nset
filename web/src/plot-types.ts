import type { ChartSpec } from "./workspace-types";
export type PlotType = "line" | "scatter" | "area" | "step" | "image";
export function plotType(card: ChartSpec): PlotType {
  if (card.kind === "image") return "image";
  const style = card.config.style;
  if (style.width === 0 && (style.markers?.show ?? style.points))
    return "scatter";
  if (style.fill > 0) return "area";
  if (style.path.startsWith("stepped-")) return "step";
  return "line";
}
/** Plot presets affect drawing, never sources or numerical interpolation/smoothing. */
export function setPlotType(card: ChartSpec, type: PlotType): void {
  card.kind = type === "image" ? "image" : "timeseries";
  if (type === "image") return;
  const style = card.config.style;
  style.path = type === "step" ? "stepped-after" : "matched";
  style.width = type === "scatter" ? 0 : style.width || 2;
  style.fill = type === "area" ? style.fill || 0.15 : 0;
  style.points = type === "scatter";
  style.markers = { ...style.markers, show: type === "scatter" };
  if (style.pathOptions) delete style.pathOptions.align;
  // A global type choice supersedes individual geometry, not colors/visibility.
  for (const patch of Object.values(card.config.runs)) {
    for (const key of ["path", "width", "fill", "points"] as const)
      delete patch[key];
    if (patch.markers) delete patch.markers.show;
    if (patch.pathOptions) delete patch.pathOptions.align;
  }
}
