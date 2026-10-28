import type { ScaleOptions, ViewConfig } from "./config";

/** Smoothing lives on the independent coordinate, never metric XY's final X.
 * Linear time uses seconds. Joined time is converted to seconds before every
 * transform; ordinary nonlinear transforms use the existing display units.
 * Defaults: sigma 1, linear join, log base 10, asinh threshold 1 step/second.
 */
export function smoothingCoordinate(
  config: ViewConfig,
  joined: boolean,
): { transform: (x: number) => number; unit: string; signature: string } {
  const time = config.axis !== "step";
  const display = (
    config.advanced.scales as Record<string, ScaleOptions> | undefined
  )?.x;
  const scale = joined ? config.joinScale : config.xScale;
  const base = joined ? config.joinLog : (display?.log ?? 10);
  const threshold = joined ? config.joinAsinh : (display?.asinh ?? 1);
  const divisor = time && (joined || scale === "linear") ? 1000 : 1;
  const transform = (x: number): number => {
    if (!Number.isFinite(x)) return NaN;
    if (scale === "log") {
      // Subtracting logs is the seconds-before-transform operation without
      // underflow when a positive millisecond input is very close to zero.
      const log = base === 2 ? Math.log2 : Math.log10;
      return x > 0 ? log(x) - log(divisor) : NaN;
    }
    if (scale === "asinh") {
      const ratio = x / threshold / divisor;
      return Number.isFinite(ratio)
        ? Math.asinh(ratio)
        : Math.sign(x) *
            (Math.log(Math.abs(x)) -
              Math.log(threshold) -
              Math.log(divisor) +
              Math.LN2);
    }
    return x / divisor;
  };
  const unit =
    scale === "linear"
      ? time
        ? "seconds"
        : "steps"
      : scale === "log"
        ? base === 2
          ? "doublings"
          : "decades"
        : "asinh units";
  // Log input units add only a constant, so they do not affect bandwidth.
  // Normalize asinh thresholds to steps/seconds to compare equivalent charts.
  const thresholdFactor = divisor / (time ? 1000 : 1);
  const normalizedThreshold = threshold * thresholdFactor;
  const parameter =
    scale === "log"
      ? base
      : scale === "asinh"
        ? normalizedThreshold > 0 &&
          normalizedThreshold / thresholdFactor === threshold
          ? normalizedThreshold
          : [threshold, divisor]
        : null;
  return {
    transform,
    unit,
    signature: JSON.stringify([config.axis, scale, parameter]),
  };
}

export function smoothingUnit(config: ViewConfig, joined: boolean): string {
  return smoothingCoordinate(config, joined).unit;
}
