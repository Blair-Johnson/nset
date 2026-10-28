import { validateConfig, type ViewConfig, type ScaleOptions } from "./config";

export type SmoothingConfig = Pick<ViewConfig, "smoothing" | "smoothingSigma">;
export interface DashboardControls {
  axis?: ViewConfig["axis"];
  /** Zero disables smoothing without changing the remembered positive sigma. */
  smoothingSigma?: number;
}

export function smoothingValue(config: SmoothingConfig): number {
  return config.smoothing ? config.smoothingSigma : 0;
}

/** Pure, validated per-chart update for a dashboard control change.
 * Changing the coordinate system resets X bounds, distribution, format and
 * advanced coordinate-dependent ticks/ranges, not explicit labels or cosmetics.
 * Same-axis and smoothing-only changes preserve all axis settings. Y settings,
 * interpolation, run styles and other presentation overrides stay untouched.
 * The caller applies this to scalar charts and clears stale navigation/pins.
 */
/** Clear coordinate-dependent X settings (bounds, distribution, format, ticks)
 * after X changes meaning. Explicit labels and cosmetics stay. Mutates. */
export function resetXAxis(next: ViewConfig): void {
  next.xMin = null;
  next.xMax = null;
  next.xScale = "linear";
  next.xFormat = "number";
  const scales = next.advanced.scales as
    Record<string, ScaleOptions> | undefined;
  if (scales?.x) {
    delete scales.x.range;
    delete scales.x.auto;
    delete scales.x.log;
    delete scales.x.asinh;
  }
  const axes = next.advanced.axes as Record<string, unknown>[] | undefined;
  if (axes?.[0]) {
    delete axes[0].splits;
    delete axes[0].incrs;
    delete axes[0].values;
  }
}

export function applyDashboardControls(
  config: ViewConfig,
  controls: DashboardControls,
): ViewConfig {
  const next = validateConfig(config);
  if (controls.axis !== undefined && controls.axis !== next.axis) {
    next.axis = controls.axis;
    resetXAxis(next);
  }
  if (controls.smoothingSigma !== undefined) {
    const sigma = controls.smoothingSigma;
    if (!Number.isFinite(sigma) || sigma < 0)
      throw new RangeError(
        "Smoothing sigma must be finite and nonnegative (0 = off)",
      );
    next.smoothing = sigma > 0;
    if (sigma > 0) next.smoothingSigma = sigma;
  }
  return validateConfig(next);
}
