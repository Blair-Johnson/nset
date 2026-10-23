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

/** Format one axis's ticks in a single shared notation, so labels never mix
 * `2e-3` with `0.0015`. Exponential is used for the whole axis only when it is
 * shorter for the majority of finite ticks. Values are unchanged either way. */
export function formatNumberTicks(values: (number | null)[]): string[] {
  const finite = values.filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  const plain = (v: number) => formatValue(v, "number");
  const exp = (v: number) =>
    Number(plain(v)).toExponential().replace("e+", "e");
  const preferExp =
    finite.filter((v) => v !== 0 && exp(v).length < plain(v).length).length >
    finite.filter((v) => v !== 0).length / 2;
  return values.map((v) =>
    v == null
      ? ""
      : !Number.isFinite(v)
        ? plain(v)
        : v === 0
          ? "0"
          : preferExp
            ? exp(v)
            : plain(v),
  );
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
      config.xScale === "linear" &&
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
