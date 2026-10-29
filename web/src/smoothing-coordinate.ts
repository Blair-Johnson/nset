import type { ScaleOptions, ViewConfig } from "./config";
import type { XY } from "./math";

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

/** Map raw-equivalent steps/seconds to the coordinate's units, preserving the
 * fraction of the full chart span. Supply all canonical pre-join channels.
 * Invalid transformed coordinates do not set the domain. Zero means there is
 * no representable span/bandwidth to smooth; callers leave observations alone.
 */
export function smoothingBandwidth(
  config: ViewConfig,
  joined: boolean,
  channels: readonly (readonly XY[])[],
  coordinate = smoothingCoordinate(config, joined),
): number {
  const sigma = config.smoothingSigma;
  // Preserve the existing linear path exactly (including Gaussian validation).
  if ((joined ? config.joinScale : config.xScale) === "linear") return sigma;
  if (!Number.isFinite(sigma) || sigma <= 0)
    throw new RangeError("sigma must be finite and positive");
  let min = Infinity,
    max = -Infinity;
  for (const channel of channels) {
    for (const [x] of channel) {
      if (!Number.isFinite(x) || !Number.isFinite(coordinate.transform(x)))
        continue;
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
  }
  if (!(max > min)) return 0;
  const transformedSpan = coordinate.transform(max) - coordinate.transform(min);
  if (!(transformedSpan > 0) || !Number.isFinite(transformedSpan)) return 0;
  const divisor = config.axis === "step" ? 1 : 1000;
  const difference = max - min;
  const rawSpan = difference / divisor;
  const mapped = sigma * (transformedSpan / rawSpan);
  if (rawSpan >= 2 ** -1022 && Number.isFinite(mapped) && mapped > 0)
    return mapped;
  // Avoid intermediate overflow/underflow, including rounding a subnormal
  // millisecond span when converting to seconds before taking its logarithm.
  const scale = Math.max(Math.abs(min), Math.abs(max));
  const logRawSpan =
    (Number.isFinite(difference)
      ? Math.log(difference)
      : Math.log(scale) + Math.log(max / scale - min / scale)) -
    Math.log(divisor);
  return Math.min(
    Number.MAX_VALUE,
    Math.exp(Math.log(sigma) + Math.log(transformedSpan) - logRawSpan),
  );
}

export function smoothingUnit(config: ViewConfig, joined: boolean): string {
  const unit = config.axis === "step" ? "steps" : "seconds";
  return (joined ? config.joinScale : config.xScale) === "linear"
    ? unit
    : `equivalent ${unit}`;
}
