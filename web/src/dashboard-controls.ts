import { validateConfig, type ViewConfig, type ScaleOptions } from "./config";

export type SmoothingConfig = Pick<ViewConfig, "smoothing" | "alpha">;
export interface DashboardControls {
  axis?: ViewConfig["axis"];
  smoothingStrength?: number;
}

export const MIN_SMOOTHING_ALPHA = 0.01;

/** Slider 0..100, None to More: alpha = 10^(-strength/50).
 * 0 maps to alpha=1 (identity), 50 to 0.1, and 100 to 0.01; never zero.
 * EMA weights the new observation by alpha, so lower alpha smooths more.
 * Fractional slider strengths are supported; invalid inputs throw, not clamp.
 */
export function strengthToAlpha(strength: number): number {
  if (!Number.isFinite(strength) || strength < 0 || strength > 100)
    throw new RangeError("Smoothing strength must be finite and in [0, 100]");
  return 10 ** (-strength / 50);
}

/** Inverse slider projection. Legacy positive alphas below 0.01 display at More
 * without changing the persisted config. They are replaced only on user edit.
 */
export function alphaToStrength(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1)
    throw new RangeError("alpha must be finite and in (0, 1]");
  return Math.max(0, Math.min(100, -50 * Math.log10(alpha)));
}

export function strengthToSmoothing(strength: number): SmoothingConfig {
  return { smoothing: strength > 0, alpha: strengthToAlpha(strength) };
}

/** Disabled legacy configs show None regardless of their remembered alpha.
 * Enabled alpha=1 also shows None because that EMA is exactly the identity.
 */
export function smoothingToStrength(config: SmoothingConfig): number {
  const strength = alphaToStrength(config.alpha);
  return config.smoothing ? strength : 0;
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
  if (controls.smoothingStrength !== undefined)
    Object.assign(next, strengthToSmoothing(controls.smoothingStrength));
  return validateConfig(next);
}
