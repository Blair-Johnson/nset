import type { ChartSpec } from "./workspace-types";
export type PlotType = "line" | "scatter" | "area" | "step" | "image";
export function plotType(card: ChartSpec): PlotType {
  if (card.kind === "image") return "image";
  const style = card.config.style;
  if (style.width === 0 && style.fill === 0) return "scatter";
  if (style.fill > 0) return "area";
  if (style.path.startsWith("stepped-")) return "step";
  return "line";
}
/**
 * Plot presets set the line geometry, never sources or numerical
 * interpolation/smoothing. Points are an independent overlay: scatter turns
 * them on (it has no line), leaving scatter turns them back off, and moving
 * between line, area and step keeps whatever overlay the user chose.
 */
export function setPlotType(card: ChartSpec, type: PlotType): void {
  const wasScatter = card.kind !== "image" && plotType(card) === "scatter";
  card.kind = type === "image" ? "image" : "timeseries";
  if (type === "image") {
    if (card.details?.measurements) {
      const { measurements: _measurements, ...details } = card.details;
      card.details = details;
    }
    return;
  }
  const style = card.config.style;
  style.path = type === "step" ? "stepped-after" : "matched";
  style.width = type === "scatter" ? 0 : style.width || 2;
  style.fill = type === "area" ? style.fill || 0.15 : 0;
  if (type === "scatter" || wasScatter) {
    style.points = type === "scatter";
    style.markers = { ...style.markers, show: type === "scatter" };
  }
  if (style.pathOptions) delete style.pathOptions.align;
  // A global type choice supersedes individual geometry, not colors/visibility.
  for (const patch of Object.values(card.config.runs)) {
    for (const key of ["path", "width", "fill"] as const) delete patch[key];
    if (type === "scatter" || wasScatter) {
      delete patch.points;
      if (patch.markers) delete patch.markers.show;
    }
    if (patch.pathOptions) delete patch.pathOptions.align;
  }
}
