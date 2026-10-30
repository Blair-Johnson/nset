import type { Plugin } from "vite";

// uPlot 1.6.32 rejects every raw interval narrower than 1e-16, including
// many-decade log windows. Preserve its linear guard, but test log windows in
// log coordinates. Remove this shim when upstream supports these intervals.
const original = "opts.max - opts.min < 1e-16";
const replacement = `(sc.distr == 3
  ? !(opts.min > 0 && Number.isFinite(opts.max) && Math.log10(opts.max) > Math.log10(opts.min))
  : opts.max - opts.min < 1e-16)`;

export function patchUplotLogRanges(source: string): string {
  if (source.split(original).length !== 2)
    throw new Error(
      "uPlot log-range compatibility patch no longer matches; review the pinned dependency before building.",
    );
  return source.replace(original, replacement);
}

export function uplotLogRanges(): Plugin {
  return {
    name: "uplot-finite-log-ranges",
    enforce: "pre",
    transform(source, id) {
      if (
        !id
          .split("?")[0]
          .replaceAll("\\", "/")
          .endsWith("/uplot/dist/uPlot.esm.js")
      )
        return;
      return { code: patchUplotLogRanges(source), map: null };
    },
  };
}
