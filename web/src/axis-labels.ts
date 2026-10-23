import { formatValue, type ViewConfig } from "./config";

/** Tick-only alternate spelling of the existing six-significant-digit number.
 * Parsing either spelling gives exactly the same value; readouts stay unchanged.
 */
export function formatNumberTick(value: number): string {
  const plain = formatValue(value, "number");
  if (!Number.isFinite(value)) return plain;
  const exponential = Number(plain).toExponential().replace("e+", "e");
  return exponential.length < plain.length ? exponential : plain;
}

/** Native multiline labels retain the entire UTC date/time (including ms). */
export function formatTimestampTick(value: number): string {
  return formatValue(value, "iso-time").replace(" ", "\n");
}

// Card defaults include colors in advanced axes. Cosmetic color/stroke changes
// are harmless; any other axis literal opts out of automatic label layout.
function hasLayoutOverride(axis: Record<string, unknown> = {}): boolean {
  return (
    Object.keys(axis).some(
      (key) => !["stroke", "grid", "ticks"].includes(key),
    ) || (axis.ticks as { size?: number } | undefined)?.size !== undefined
  );
}

export function defaultLabelLayout(config: ViewConfig): {
  compactY: boolean;
  multilineTime: boolean;
} {
  const axes = (config.advanced.axes ?? []) as Record<string, unknown>[];
  return {
    compactY: config.yFormat === "number" && !hasLayoutOverride(axes[1]),
    // Right-aligned time text uses the default left Y gutter. Do not assume
    // that clearance when the user owns either axis layout or the padding.
    multilineTime:
      config.axis === "timestamp" &&
      config.xFormat === "number" &&
      config.advanced.padding === undefined &&
      !axes.some(hasLayoutOverride),
  };
}

/** UTC Date text cannot distinguish fractional milliseconds. Retain the native
 * numeric progression, but never manufacture two labels for the same millisecond.
 * The supported Date span is at most 1.728e16 milliseconds. */
export const timestampTickIncrements = Array.from(
  { length: 17 },
  (_, exponent) => [1, 2, 2.5, 5].map((multiple) => multiple * 10 ** exponent),
)
  .flat()
  .filter(Number.isInteger);
