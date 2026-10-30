import type uPlot from "uplot";

const MAX_TICKS = 4096;
const MIN_SPACE = 8;
const decimalMultiples = [[1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 5], [1]];
const binaryMultiples = [[1, 1.5], [1]];

/** Generate ticks without accumulating/rounding a floating-point increment.
 * Integer exponents cover every positive finite double (including subnormals).
 * Both major and minor ticks respect CSS-pixel spacing, with a hard output cap.
 */
export function logTicks(
  min: number,
  max: number,
  base: 2 | 10,
  pixels: number,
  space = 50,
): number[] {
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    !(min > 0 && min < max) ||
    !Number.isFinite(pixels) ||
    pixels <= 0
  )
    return [];

  const log = base === 10 ? Math.log10 : Math.log2;
  const lo = log(min),
    hi = log(max);
  const minSpace = Math.max(MIN_SPACE, Number.isFinite(space) ? space : 50);
  const limit = Math.min(MAX_TICKS, Math.floor(pixels / minSpace) + 1);
  // Adjacent doubles can have identical rounded logarithms. One tick is enough.
  if (limit <= 1 || !(hi > lo)) return [min];
  const spacing = Math.max(minSpace, pixels / (MAX_TICKS - 1));
  const pixelsPerExponent = pixels / (hi - lo);
  const stride = Math.max(1, Math.ceil(spacing / pixelsPerExponent));
  const patterns = base === 10 ? decimalMultiples : binaryMultiples;
  const multiples = patterns.find((pattern) =>
    pattern.every(
      (multiple, i) =>
        log((pattern[i + 1] ?? base) / multiple) * pixelsPerExponent >= spacing,
    ),
  ) ?? [1];
  const first = Math.max(base === 10 ? -324 : -1074, Math.floor(lo) - 1);
  const last = Math.min(base === 10 ? 308 : 1023, Math.ceil(hi) + 1);
  const ticks: number[] = [];
  let previousLog = -Infinity;

  // At most 633 decimal decades or 2098 binary exponents; no value-driven loop.
  for (
    let exponent = Math.ceil(first / stride) * stride;
    exponent <= last;
    exponent += stride
  ) {
    for (const multiple of multiples) {
      // Parsing the full decimal avoids both 10**-324 underflow and imprecise
      // decimal powers. Binary powers are exact, including 2**-1074.
      const value =
        base === 10
          ? Number(`${multiple}e${exponent}`)
          : multiple * 2 ** exponent;
      if (
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        value <= (ticks.at(-1) ?? 0)
      )
        continue;
      const exponentValue = log(value);
      // Subnormal rounding can compress or duplicate otherwise spaced ticks.
      if ((exponentValue - previousLog) * pixelsPerExponent < spacing - 1e-7)
        continue;
      ticks.push(value);
      previousLog = exponentValue;
      if (ticks.length >= limit) return ticks;
    }
  }
  // Narrow ranges need not contain a power or one of its small multiples.
  return ticks.length ? ticks : [min];
}

/** uPlot passes ascending bounds even for reversed axes. Absolute CSS distance
 * handles either axis/orientation/direction without device-pixel assumptions.
 */
export const logAxisSplits: Exclude<uPlot.Axis.Splits, number[]> = (
  u,
  axisIndex,
  min,
  max,
) => {
  const axis = u.axes[axisIndex];
  const scaleKey = axis.scale ?? (axisIndex === 0 ? "x" : "y");
  const base = u.scales[scaleKey].log === 2 ? 2 : 10;
  // Ignore foundIncr/foundSpace: uPlot's linear increment search can select
  // 1e-16 even for a 1e-300..1e-290 window, yielding huge but nonzero spacing.
  // That passes its pre-split gate; log tick density must use the viewport.
  const pixels = Math.abs(
    u.valToPos(max, scaleKey) - u.valToPos(min, scaleKey),
  );
  const space =
    typeof axis.space === "function"
      ? axis.space(u, axisIndex, min, max, pixels)
      : axis.space;
  return logTicks(min, max, base, pixels, space);
};
